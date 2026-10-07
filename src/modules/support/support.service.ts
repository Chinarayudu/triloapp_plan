import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, or, SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { calls, supportMessages, supportTickets, users, withdrawalRequests } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { deleteObject, generateDownloadUrl, generateUploadUrl, getObjectInfo } from "../../lib/s3";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";

// Support chat (Host app and User app): a host or user opens a ticket and
// writes; the support bot answers first (supportBot.service.ts), and admins
// answer as "agent" from the admin dashboard. The owner writing on a
// resolved, closed or waiting-on-customer ticket sets it back to "open".

type Ticket = typeof supportTickets.$inferSelect;
type TicketStatus = Ticket["status"];
type TicketPriority = Ticket["priority"];
type Sender = (typeof supportMessages.$inferSelect)["sender"];
export type AccountRole = "host" | "user";
type Owner = { id: string; name: string | null; phone: string; role: string };

const SENDER_FALLBACK_NAME: Record<Sender, string> = { host: "Host", user: "User", agent: "Support team", bot: "Support assistant" };

// One shape for a ticket everywhere (app list, app thread, admin list, admin
// thread): every stored field, plus the requester, their app (role) and the
// refs grouped. The bot's summary is for staff only.
function ticketView(ticket: Ticket, owner: Owner, audience: "owner" | "admin") {
  const { summary, refCallId, refWithdrawalId, ...fields } = ticket;
  return {
    ...fields,
    role: owner.role,
    requester: { id: owner.id, name: owner.name ?? "Unknown" },
    refs: { callId: refCallId, withdrawalId: refWithdrawalId },
    ...(audience === "admin" ? { summary } : {}),
  };
}

export async function getTicket(ticketId: string): Promise<Ticket> {
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1);
  if (!ticket) throw new AppError(404, "Ticket not found");
  return ticket;
}

async function getOwner(accountId: string): Promise<Owner> {
  const [owner] = await db
    .select({ id: users.id, name: users.name, phone: users.phone, role: users.role })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!owner) throw new Error(`Support ticket owner ${accountId} not found`);
  return owner;
}

async function getOwnTicket(accountId: string, ticketId: string): Promise<Ticket> {
  const ticket = await getTicket(ticketId);
  if (ticket.accountId !== accountId) throw new AppError(404, "Ticket not found"); // not theirs = doesn't exist for them
  return ticket;
}

export async function listMessages(ticketId: string) {
  const rows = await db
    .select({ message: supportMessages, senderUserName: users.name })
    .from(supportMessages)
    .leftJoin(users, eq(users.id, supportMessages.senderUserId))
    .where(eq(supportMessages.ticketId, ticketId))
    .orderBy(asc(supportMessages.createdAt));
  const messages = [];
  for (const { message, senderUserName } of rows) {
    messages.push({
      id: message.id,
      sender: message.sender,
      senderName: senderUserName ?? SENDER_FALLBACK_NAME[message.sender],
      content: message.content,
      // At most one photo per message; a fresh signed URL every time it's served.
      attachments: message.mediaKey
        ? [{ type: "image" as const, url: await generateDownloadUrl(message.mediaKey, ATTACHMENT_URL_TTL_SECONDS) }]
        : [],
      createdAt: message.createdAt,
    });
  }
  return messages;
}

// ---- Photo attachments ------------------------------------------------------
// The same presign-then-send flow as chat photos: the app asks for an upload
// URL, PUTs the photo to S3, then sends the message with the mediaKey.
// Support photos only ever go to the support team, so they aren't run through
// image moderation like chat photos are.

const ATTACHMENT_URL_TTL_SECONDS = 60 * 60;
const ATTACHMENT_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export async function issueSupportUploadUrl(accountId: string, contentType: string) {
  const extension = ATTACHMENT_TYPES[contentType];
  if (!extension) throw new AppError(400, "Photos must be JPEG, PNG or WebP");
  const mediaKey = `support/${accountId}/${randomUUID()}.${extension}`;
  return { uploadUrl: await generateUploadUrl(mediaKey, contentType), mediaKey, expiresIn: 300 };
}

// The key must be one issued to this account, the upload must exist, be a
// photo and be at most 5 MB.
async function checkAttachment(accountId: string, mediaKey: string): Promise<void> {
  if (!mediaKey.startsWith(`support/${accountId}/`)) throw new AppError(400, "Invalid mediaKey");
  const info = await getObjectInfo(mediaKey);
  if (!info) throw new AppError(400, "The photo hasn't been uploaded yet");
  if (info.sizeBytes > ATTACHMENT_MAX_BYTES) {
    await deleteObject(mediaKey);
    throw new AppError(413, "Photos can be at most 5 MB");
  }
  if (!info.contentType || !ATTACHMENT_TYPES[info.contentType]) throw new AppError(400, "Photos must be JPEG, PNG or WebP");
}

async function addMessage(ticket: Ticket, sender: Sender, senderUserId: string | null, content: string, mediaKey: string | null = null) {
  const now = new Date();
  const fromOwner = sender === "host" || sender === "user";
  // The owner writing back puts the ticket in front of staff again — unless
  // someone is already working on it.
  const reopens = fromOwner && (ticket.status === "resolved" || ticket.status === "closed" || ticket.status === "waiting_on_customer");
  await db.transaction(async (tx) => {
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender, senderUserId, content, mediaKey, createdAt: now });
    await tx
      .update(supportTickets)
      .set({
        lastMessageAt: now,
        updatedAt: now,
        ...(reopens ? { status: "open" as const } : {}),
        // A person has taken the ticket over — it leaves the "needs a person" queue.
        ...(sender === "agent" ? { needsAgent: false, handoffReason: null } : {}),
      })
      .where(eq(supportTickets.id, ticket.id));
  });
  const messages = await listMessages(ticket.id);
  return messages[messages.length - 1];
}

// The owner sees agent and bot replies live (support:message), or as a push if the app is closed.
async function notifyOwner(ticket: Ticket, message: Awaited<ReturnType<typeof addMessage>>, pushTitle: string) {
  emitToUser(ticket.accountId, "support:message", { ticketId: ticket.id, message });
  if (!(await isUserConnected(ticket.accountId))) {
    void sendPushNotification(ticket.accountId, pushTitle, message.content.slice(0, 100) || "📷 Photo");
  }
}

// ---- Host app / User app ----------------------------------------------------

export async function listOwnTickets(accountId: string) {
  const [owner, rows] = await Promise.all([
    getOwner(accountId),
    db.select().from(supportTickets).where(eq(supportTickets.accountId, accountId)).orderBy(desc(supportTickets.lastMessageAt)),
  ]);
  return { tickets: rows.map((t) => ticketView(t, owner, "owner")), total: rows.length };
}

export type TicketRefs = { callId?: string; withdrawalId?: string };

// A ticket can point at the call or withdrawal it's about — only one of the
// owner's own.
async function checkRefsBelongTo(accountId: string, refs: TicketRefs): Promise<void> {
  if (refs.callId) {
    const [call] = await db.select().from(calls).where(eq(calls.id, refs.callId)).limit(1);
    if (!call || (call.userId !== accountId && call.hostId !== accountId)) throw new AppError(400, "refs.callId isn't one of your calls");
  }
  if (refs.withdrawalId) {
    const [withdrawal] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, refs.withdrawalId)).limit(1);
    if (!withdrawal || withdrawal.hostId !== accountId) throw new AppError(400, "refs.withdrawalId isn't one of your withdrawals");
  }
}

export async function createTicket(
  accountId: string,
  role: AccountRole,
  subject: string,
  category: string,
  content: string,
  refs: TicketRefs,
  mediaKey: string | null,
) {
  await checkRefsBelongTo(accountId, refs);
  if (mediaKey) await checkAttachment(accountId, mediaKey);
  const ticketId = await db.transaction(async (tx) => {
    const [ticket] = await tx
      .insert(supportTickets)
      .values({ accountId, subject, category, refCallId: refs.callId ?? null, refWithdrawalId: refs.withdrawalId ?? null })
      .returning();
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender: role, senderUserId: accountId, content, mediaKey });
    return ticket.id;
  });
  return getOwnTicketWithMessages(accountId, ticketId);
}

export async function getOwnTicketWithMessages(accountId: string, ticketId: string) {
  const ticket = await getOwnTicket(accountId, ticketId);
  return { ticket: ticketView(ticket, await getOwner(accountId), "owner"), messages: await listMessages(ticketId) };
}

export async function addOwnerMessage(accountId: string, role: AccountRole, ticketId: string, content: string, mediaKey: string | null) {
  const ticket = await getOwnTicket(accountId, ticketId);
  if (mediaKey) await checkAttachment(accountId, mediaKey);
  return addMessage(ticket, role, accountId, content, mediaKey);
}

// ---- Support bot ------------------------------------------------------------

export async function addBotMessage(ticket: Ticket, content: string) {
  const message = await addMessage(ticket, "bot", null, content);
  await notifyOwner(ticket, message, "Support replied");
  return message;
}

export async function markNeedsAgent(ticketId: string, reason: string, summary: string | null = null): Promise<void> {
  await db
    .update(supportTickets)
    .set({ needsAgent: true, handoffReason: reason, ...(summary ? { summary } : {}), updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId));
}

// ---- Admin side -------------------------------------------------------------

export async function getTicketWithMessages(ticketId: string) {
  const ticket = await getTicket(ticketId);
  return { ticket: ticketView(ticket, await getOwner(ticket.accountId), "admin"), messages: await listMessages(ticketId) };
}

export type AdminTicketQuery = {
  status?: TicketStatus;
  role?: AccountRole;
  category?: string;
  q?: string;
  needsAgent?: boolean;
  page: number;
  pageSize: number;
};

export async function listTicketsForAdmin(query: AdminTicketQuery) {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(supportTickets.status, query.status));
  if (query.role) conditions.push(eq(users.role, query.role));
  if (query.category) conditions.push(eq(supportTickets.category, query.category));
  if (query.needsAgent !== undefined) conditions.push(eq(supportTickets.needsAgent, query.needsAgent));
  if (query.q) {
    const text = or(ilike(supportTickets.subject, `%${query.q}%`), ilike(users.name, `%${query.q}%`))!;
    conditions.push(/^[0-9a-f-]{36}$/i.test(query.q) ? or(eq(supportTickets.id, query.q), text)! : text);
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ticket: supportTickets, account: { id: users.id, name: users.name, phone: users.phone, role: users.role } })
      .from(supportTickets)
      .innerJoin(users, eq(users.id, supportTickets.accountId))
      .where(where)
      .orderBy(desc(supportTickets.lastMessageAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(supportTickets).innerJoin(users, eq(users.id, supportTickets.accountId)).where(where),
  ]);

  return {
    // Flat ticket fields for the admin Support screen, plus the original
    // { ticket, account } pair this list returned first.
    tickets: rows.map(({ ticket, account }) => ({ ...ticketView(ticket, account, "admin"), ticket, account })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.page * query.pageSize < total,
  };
}

export async function addAgentMessage(adminId: string, ticketId: string, content: string) {
  const ticket = await getTicket(ticketId);
  const message = await addMessage(ticket, "agent", adminId, content);
  await notifyOwner(ticket, message, "Support replied");
  return message;
}

export type TicketUpdate = { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null };

// Returns the ticket before and after, for the audit log.
export async function updateTicketAsAdmin(ticketId: string, update: TicketUpdate) {
  const before = await getTicket(ticketId);
  if (update.assigneeId) {
    const [assignee] = await db.select({ role: users.role }).from(users).where(eq(users.id, update.assigneeId)).limit(1);
    if (!assignee || (assignee.role !== "admin" && assignee.role !== "sub_admin")) {
      throw new AppError(400, "assigneeId must be an admin");
    }
  }
  const [after] = await db
    .update(supportTickets)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId))
    .returning();
  return { before, after: ticketView(after, await getOwner(after.accountId), "admin") };
}

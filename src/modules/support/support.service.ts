import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { supportMessages, supportTickets, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";

// Support chat (Host app and User app): a host or user opens a ticket and
// writes; the support bot answers first (supportBot.service.ts), and admins
// answer as "agent" from the admin dashboard. The owner writing on a closed
// ticket reopens it.

type Ticket = typeof supportTickets.$inferSelect;
type Sender = (typeof supportMessages.$inferSelect)["sender"];
export type AccountRole = "host" | "user";

const SENDER_FALLBACK_NAME: Record<Sender, string> = { host: "Host", user: "User", agent: "Support team", bot: "Support assistant" };

export async function getTicket(ticketId: string): Promise<Ticket> {
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1);
  if (!ticket) throw new AppError(404, "Ticket not found");
  return ticket;
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
  return rows.map(({ message, senderUserName }) => ({
    id: message.id,
    sender: message.sender,
    senderName: senderUserName ?? SENDER_FALLBACK_NAME[message.sender],
    content: message.content,
    createdAt: message.createdAt,
  }));
}

async function addMessage(ticket: Ticket, sender: Sender, senderUserId: string | null, content: string) {
  const now = new Date();
  const fromOwner = sender === "host" || sender === "user";
  await db.transaction(async (tx) => {
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender, senderUserId, content, createdAt: now });
    await tx
      .update(supportTickets)
      .set({
        lastMessageAt: now,
        updatedAt: now,
        ...(fromOwner ? { status: "open" as const } : {}),
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
    void sendPushNotification(ticket.accountId, pushTitle, message.content.slice(0, 100));
  }
}

// ---- Host app / User app ----------------------------------------------------

export async function listOwnTickets(accountId: string) {
  return db.select().from(supportTickets).where(eq(supportTickets.accountId, accountId)).orderBy(desc(supportTickets.lastMessageAt));
}

export async function createTicket(accountId: string, role: AccountRole, subject: string, category: string, content: string) {
  const ticketId = await db.transaction(async (tx) => {
    const [ticket] = await tx.insert(supportTickets).values({ accountId, subject, category }).returning();
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender: role, senderUserId: accountId, content });
    return ticket.id;
  });
  return getTicketWithMessages(ticketId);
}

export async function getOwnTicketWithMessages(accountId: string, ticketId: string) {
  await getOwnTicket(accountId, ticketId);
  return getTicketWithMessages(ticketId);
}

export async function addOwnerMessage(accountId: string, role: AccountRole, ticketId: string, content: string) {
  return addMessage(await getOwnTicket(accountId, ticketId), role, accountId, content);
}

// ---- Support bot ------------------------------------------------------------

export async function addBotMessage(ticket: Ticket, content: string) {
  const message = await addMessage(ticket, "bot", null, content);
  await notifyOwner(ticket, message, "Support replied");
  return message;
}

export async function markNeedsAgent(ticketId: string, reason: string): Promise<void> {
  await db
    .update(supportTickets)
    .set({ needsAgent: true, handoffReason: reason, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId));
}

// ---- Admin side -------------------------------------------------------------

export async function getTicketWithMessages(ticketId: string) {
  return { ticket: await getTicket(ticketId), messages: await listMessages(ticketId) };
}

export async function listTicketsForAdmin(filter: { status?: Ticket["status"]; needsAgent?: boolean }) {
  const conditions = [];
  if (filter.status) conditions.push(eq(supportTickets.status, filter.status));
  if (filter.needsAgent !== undefined) conditions.push(eq(supportTickets.needsAgent, filter.needsAgent));
  return db
    .select({ ticket: supportTickets, account: { id: users.id, name: users.name, phone: users.phone, role: users.role } })
    .from(supportTickets)
    .innerJoin(users, eq(users.id, supportTickets.accountId))
    .where(and(...conditions))
    .orderBy(desc(supportTickets.lastMessageAt));
}

export async function addAgentMessage(adminId: string, ticketId: string, content: string) {
  const ticket = await getTicket(ticketId);
  const message = await addMessage(ticket, "agent", adminId, content);
  await notifyOwner(ticket, message, "Support replied");
  return message;
}

export async function setTicketStatus(ticketId: string, status: Ticket["status"]) {
  await getTicket(ticketId);
  const [updated] = await db
    .update(supportTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId))
    .returning();
  return updated;
}

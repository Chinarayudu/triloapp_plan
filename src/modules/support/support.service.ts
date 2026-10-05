import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { supportMessages, supportTickets, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";

// Host support chat (Host app "Support chat"): a host opens a ticket and
// writes; admins answer as "agent" from the admin dashboard. A host writing
// on a closed ticket reopens it.

type Ticket = typeof supportTickets.$inferSelect;
type Sender = (typeof supportMessages.$inferSelect)["sender"];

const SENDER_FALLBACK_NAME: Record<Sender, string> = { host: "Host", agent: "Support team", bot: "Support bot" };

async function getTicket(ticketId: string): Promise<Ticket> {
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1);
  if (!ticket) throw new AppError(404, "Ticket not found");
  return ticket;
}

async function getOwnTicket(hostId: string, ticketId: string): Promise<Ticket> {
  const ticket = await getTicket(ticketId);
  if (ticket.hostId !== hostId) throw new AppError(404, "Ticket not found"); // not theirs = doesn't exist for them
  return ticket;
}

async function listMessages(ticketId: string) {
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

async function addMessage(ticket: Ticket, sender: Sender, senderUserId: string, content: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender, senderUserId, content, createdAt: now });
    await tx
      .update(supportTickets)
      .set({ lastMessageAt: now, updatedAt: now, ...(sender === "host" ? { status: "open" as const } : {}) })
      .where(eq(supportTickets.id, ticket.id));
  });
  const messages = await listMessages(ticket.id);
  return messages[messages.length - 1];
}

// ---- Host side --------------------------------------------------------------

export async function listHostTickets(hostId: string) {
  return db.select().from(supportTickets).where(eq(supportTickets.hostId, hostId)).orderBy(desc(supportTickets.lastMessageAt));
}

export async function createTicket(hostId: string, subject: string, category: string, content: string) {
  const ticketId = await db.transaction(async (tx) => {
    const [ticket] = await tx.insert(supportTickets).values({ hostId, subject, category }).returning();
    await tx.insert(supportMessages).values({ ticketId: ticket.id, sender: "host", senderUserId: hostId, content });
    return ticket.id;
  });
  return getTicketWithMessages(ticketId);
}

export async function getOwnTicketWithMessages(hostId: string, ticketId: string) {
  await getOwnTicket(hostId, ticketId);
  return getTicketWithMessages(ticketId);
}

export async function addHostMessage(hostId: string, ticketId: string, content: string) {
  return addMessage(await getOwnTicket(hostId, ticketId), "host", hostId, content);
}

// ---- Admin side -------------------------------------------------------------

export async function getTicketWithMessages(ticketId: string) {
  return { ticket: await getTicket(ticketId), messages: await listMessages(ticketId) };
}

export async function listTicketsForAdmin(status?: Ticket["status"]) {
  return db
    .select({ ticket: supportTickets, host: { id: users.id, name: users.name, phone: users.phone } })
    .from(supportTickets)
    .innerJoin(users, eq(users.id, supportTickets.hostId))
    .where(status ? eq(supportTickets.status, status) : undefined)
    .orderBy(desc(supportTickets.lastMessageAt));
}

// The host sees the reply live (support:message), or as a push if the app is closed.
export async function addAgentMessage(adminId: string, ticketId: string, content: string) {
  const ticket = await getTicket(ticketId);
  const message = await addMessage(ticket, "agent", adminId, content);
  emitToUser(ticket.hostId, "support:message", { ticketId: ticket.id, message });
  if (!(await isUserConnected(ticket.hostId))) {
    void sendPushNotification(ticket.hostId, "Support replied", content.slice(0, 100));
  }
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

import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../../db/client";
import { chatConversations, chatMessages, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { areBlocked } from "../moderation/blocks.service";
import { getUserById } from "../users/users.service";

type ChatConversation = typeof chatConversations.$inferSelect;

// A conversation is always keyed by (userId, hostId), regardless of who
// sent the first message — resolves which of sender/recipient is which
// and validates the recipient is actually the opposite role.
async function resolveParticipants(
  senderId: string,
  senderRole: "user" | "host",
  recipientId: string,
): Promise<{ userId: string; hostId: string }> {
  const recipient = await getUserById(recipientId);
  if (!recipient || recipient.status !== "active") {
    throw new AppError(404, "Recipient not found");
  }

  if (await areBlocked(senderId, recipientId)) {
    throw new AppError(403, "This message cannot be delivered");
  }

  if (senderRole === "user") {
    if (recipient.role !== "host") throw new AppError(400, "Users can only message hosts");
    return { userId: senderId, hostId: recipientId };
  }

  if (recipient.role !== "user") throw new AppError(400, "Hosts can only message users");
  return { userId: recipientId, hostId: senderId };
}

export async function findOrCreateConversation(
  senderId: string,
  senderRole: "user" | "host",
  recipientId: string,
): Promise<ChatConversation> {
  const { userId, hostId } = await resolveParticipants(senderId, senderRole, recipientId);

  const [existing] = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.userId, userId), eq(chatConversations.hostId, hostId)))
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(chatConversations).values({ userId, hostId }).returning();
  return created;
}

export async function getConversationById(id: string): Promise<ChatConversation | undefined> {
  const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, id)).limit(1);
  return conversation;
}

export function otherParticipantId(conversation: ChatConversation, viewerId: string): string {
  return conversation.userId === viewerId ? conversation.hostId : conversation.userId;
}

export async function sendMessage(conversationId: string, senderId: string, content: string) {
  const [message] = await db
    .insert(chatMessages)
    .values({ conversationId, senderId, content })
    .returning();
  await db
    .update(chatConversations)
    .set({ lastMessageAt: message.createdAt })
    .where(eq(chatConversations.id, conversationId));
  return message;
}

export async function listMessages(conversationId: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(pageSize)
    .offset(offset);
  return messages;
}

export async function listConversations(viewerId: string) {
  const rows = await db
    .select({
      id: chatConversations.id,
      userId: chatConversations.userId,
      hostId: chatConversations.hostId,
      lastMessageAt: chatConversations.lastMessageAt,
      createdAt: chatConversations.createdAt,
    })
    .from(chatConversations)
    .where(or(eq(chatConversations.userId, viewerId), eq(chatConversations.hostId, viewerId)))
    .orderBy(desc(chatConversations.lastMessageAt));

  const conversations = [];
  for (const row of rows) {
    const otherId = otherParticipantId(row, viewerId);
    const [other] = await db
      .select({ id: users.id, name: users.name, phone: users.phone, role: users.role })
      .from(users)
      .where(eq(users.id, otherId))
      .limit(1);
    conversations.push({ ...row, otherParticipant: other });
  }
  return conversations;
}

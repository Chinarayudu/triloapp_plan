import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../../db/client";
import { chatConversations, chatMessages, giftTransactions, gifts, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { checkChatImage } from "../../lib/imageModeration";
import { logger } from "../../lib/logger";
import { deleteObject, generateDownloadUrl, generateUploadUrl, getObjectInfo } from "../../lib/s3";
import { createReport } from "../moderation/moderation.service";
import { areBlocked } from "../moderation/blocks.service";
import { getUserById } from "../users/users.service";
import { getHostEffectivePrices, notifyIfLevelledUp } from "../hosts/levels";
import { getCurrentCommissionBasisPoints, getCurrentPaisePerBean, transferUserToHost } from "../wallet/wallet.service";

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

// mediaKey set = a photo message (content is then its optional caption).
export async function sendMessage(conversationId: string, senderId: string, content: string, mediaKey: string | null = null) {
  const [message] = await db
    .insert(chatMessages)
    .values({ conversationId, senderId, content, type: mediaKey ? "image" : "text", mediaKey })
    .returning();
  await db
    .update(chatConversations)
    .set({ lastMessageAt: message.createdAt })
    .where(eq(chatConversations.id, conversationId));
  return message;
}

// User→host messages are paid (host levels, hosts/levels.ts) — same
// commission→beans math and snapshot reasoning as gifts.service.ts's sendGift.
// The message row and the money transfer commit together: a user with too
// little balance gets a 402 and the message is never stored or delivered.
// A photo (mediaKey) costs the same as a text message.
export async function sendPaidUserMessage(conversation: ChatConversation, content: string, mediaKey: string | null = null) {
  const { messageRatePaise: price } = await getHostEffectivePrices(conversation.hostId);
  const commissionBasisPointsSnapshot = await getCurrentCommissionBasisPoints(conversation.hostId);
  const paisePerBeanSnapshot = await getCurrentPaisePerBean();
  const commissionAmount = Math.floor((price * commissionBasisPointsSnapshot) / 10_000);
  const netToHost = price - commissionAmount;
  const beans = Math.floor(netToHost / paisePerBeanSnapshot);

  const { message, transfer } = await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(chatMessages)
      .values({
        conversationId: conversation.id,
        senderId: conversation.userId,
        type: mediaKey ? "image" : "text",
        mediaKey,
        content,
        chargedPaise: price,
        commissionBasisPointsSnapshot,
        paisePerBeanSnapshot,
        beansCredited: beans,
      })
      .returning();

    const transfer = await transferUserToHost(tx, {
      userId: conversation.userId,
      hostId: conversation.hostId,
      amountPaise: price,
      beans,
      referenceType: "chat_message",
      referenceId: message.id,
      debitIdempotencyKey: `chat:${message.id}:debit`,
      creditIdempotencyKey: `chat:${message.id}:credit`,
    });

    await tx.update(chatConversations).set({ lastMessageAt: message.createdAt }).where(eq(chatConversations.id, conversation.id));
    return { message, transfer };
  });

  notifyIfLevelledUp(conversation.hostId, transfer.hostLifetimeBeansBefore, transfer.hostLifetimeBeansAfter);
  return { message, userBalanceAfterPaise: transfer.userBalanceAfter };
}

// Photos are private objects: every time a message is served it gets a fresh
// signed URL, valid for an hour.
const CHAT_MEDIA_URL_TTL_SECONDS = 60 * 60;

export async function chatMediaUrl(message: { type: string; mediaKey: string | null }): Promise<string | null> {
  if (message.type !== "image" || !message.mediaKey) return null;
  return generateDownloadUrl(message.mediaKey, CHAT_MEDIA_URL_TTL_SECONDS);
}

// ---- Photos -----------------------------------------------------------------

const CHAT_IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Step 1 of sending a photo: a presigned PUT for a key tied to this
// conversation and this sender. Refused for anyone the sender couldn't message.
export async function issueChatUploadUrl(senderId: string, senderRole: "user" | "host", recipientId: string, contentType: string) {
  const extension = CHAT_IMAGE_TYPES[contentType];
  if (!extension) throw new AppError(400, "Photos must be JPEG, PNG or WebP");
  const conversation = await findOrCreateConversation(senderId, senderRole, recipientId);
  const mediaKey = `chat/${conversation.id}/${senderId}/${randomUUID()}.${extension}`;
  return { uploadUrl: await generateUploadUrl(mediaKey, contentType), mediaKey, expiresIn: 300 };
}

// Step 2, before the photo message is saved: the key must be one issued to
// this sender for this conversation, the upload must exist, be a photo and
// be at most 5 MB, and it must pass automated image moderation. A photo that
// fails moderation is never delivered or charged, and is reported for review.
export async function verifyChatImage(conversation: ChatConversation, senderId: string, senderRole: "user" | "host", mediaKey: string) {
  if (!mediaKey.startsWith(`chat/${conversation.id}/${senderId}/`)) throw new AppError(400, "Invalid mediaKey");
  const info = await getObjectInfo(mediaKey);
  if (!info) throw new AppError(400, "The photo hasn't been uploaded yet");
  if (info.sizeBytes > CHAT_IMAGE_MAX_BYTES) {
    await deleteObject(mediaKey);
    throw new AppError(413, "Photos can be at most 5 MB");
  }
  if (!info.contentType || !CHAT_IMAGE_TYPES[info.contentType]) throw new AppError(400, "Photos must be JPEG, PNG or WebP");

  let check;
  try {
    check = await checkChatImage(mediaKey);
  } catch (err) {
    logger.error({ err, mediaKey }, "Image moderation failed — photo not sent");
    throw new AppError(503, "Photos can't be checked right now — please try again");
  }
  if (check.checked && !check.allowed) {
    await createReport(
      senderId,
      senderRole,
      senderId,
      `Automated: chat photo blocked by image moderation (${check.labels.join(", ")}). Object: ${mediaKey}`,
    );
    throw new AppError(422, "This photo can't be sent");
  }
}

// Gift messages come back with the gift that was sent ({ id, name, iconUrl },
// from the gift catalog via the gift transaction); text messages have gift: null.
export async function listMessages(conversationId: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const rows = await db
    .select({ message: chatMessages, giftId: gifts.id, giftName: gifts.name, giftIconUrl: gifts.iconUrl })
    .from(chatMessages)
    .leftJoin(giftTransactions, eq(giftTransactions.id, chatMessages.giftTransactionId))
    .leftJoin(gifts, eq(gifts.id, giftTransactions.giftId))
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(pageSize)
    .offset(offset);
  const result = [];
  for (const r of rows) {
    result.push({
      ...r.message,
      gift: r.message.type === "gift" && r.giftId ? { id: r.giftId, name: r.giftName, iconUrl: r.giftIconUrl } : null,
      mediaUrl: await chatMediaUrl(r.message),
    });
  }
  return result;
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

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { chatConversations, chatMessages, giftContextEnum, giftRequests, giftTransactions, gifts } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { findOrCreateConversation } from "../chat/chat.service";
import { getUserById } from "../users/users.service";
import { getCurrentCommissionBasisPoints, getCurrentPaisePerBean, transferUserToHost } from "../wallet/wallet.service";
import { notifyIfLevelledUp } from "../hosts/levels";

type Gift = typeof gifts.$inferSelect;
type ChatMessage = typeof chatMessages.$inferSelect;
type GiftContext = (typeof giftContextEnum.enumValues)[number];

export async function listActiveGifts(): Promise<Gift[]> {
  return db.select().from(gifts).where(eq(gifts.active, true)).orderBy(gifts.pricePaise);
}

export async function getGiftById(id: string): Promise<Gift | undefined> {
  const [gift] = await db.select().from(gifts).where(eq(gifts.id, id)).limit(1);
  return gift;
}

export async function sendGift(
  senderId: string,
  recipientId: string,
  giftId: string,
  context?: GiftContext,
  contextId?: string,
) {
  const gift = await getGiftById(giftId);
  if (!gift || !gift.active) throw new AppError(404, "Gift not found");

  const recipient = await getUserById(recipientId);
  if (!recipient || recipient.role !== "host" || recipient.status !== "active") {
    throw new AppError(400, "Recipient must be an active host");
  }

  // Same snapshot-at-time-of-transaction reasoning as calls (BR-COM-02) —
  // a later admin config change shouldn't rewrite a gift already sent.
  // recipientId (the host) is passed so a per-host override (BR-COM-03)
  // applies here too, same as calls.
  // A chat gift also appears in the conversation as a gift message, so it must
  // belong to the real (user, host) conversation — found or created exactly like
  // a first text message (including the block check), never taken on trust
  // from the client's contextId.
  const conversation = context === "chat" ? await findOrCreateConversation(senderId, "user", recipientId) : null;

  const commissionBasisPointsSnapshot = await getCurrentCommissionBasisPoints(recipientId);
  const paisePerBeanSnapshot = await getCurrentPaisePerBean();
  const price = gift.pricePaise;
  const commissionAmount = Math.floor((price * commissionBasisPointsSnapshot) / 10_000);
  const netToHost = price - commissionAmount;
  const beans = Math.floor(netToHost / paisePerBeanSnapshot);

  const { giftTxn, transfer, chatMessage } = await db.transaction(async (tx) => {
    const [giftTxn] = await tx
      .insert(giftTransactions)
      .values({
        senderId,
        recipientId,
        giftId,
        context,
        contextId: conversation ? conversation.id : contextId,
        pricePaiseSnapshot: price,
        commissionBasisPointsSnapshot,
        paisePerBeanSnapshot,
        beansCredited: beans,
      })
      .returning();

    const transfer = await transferUserToHost(tx, {
      userId: senderId,
      hostId: recipientId,
      amountPaise: price,
      beans,
      referenceType: "gift",
      referenceId: giftTxn.id,
      debitIdempotencyKey: `gift:${giftTxn.id}:debit`,
      creditIdempotencyKey: `gift:${giftTxn.id}:credit`,
    });

    // Same transaction as the charge: a gift message exists exactly when the
    // gift was paid for. No per-message charge — the gift price covers it.
    let chatMessage: ChatMessage | null = null;
    if (conversation) {
      [chatMessage] = await tx
        .insert(chatMessages)
        .values({ conversationId: conversation.id, senderId, type: "gift", giftTransactionId: giftTxn.id, content: "" })
        .returning();
      await tx.update(chatConversations).set({ lastMessageAt: chatMessage.createdAt }).where(eq(chatConversations.id, conversation.id));
    }

    return { giftTxn, transfer, chatMessage };
  });

  notifyIfLevelledUp(recipientId, transfer.hostLifetimeBeansBefore, transfer.hostLifetimeBeansAfter);
  return { ...giftTxn, gift, chatMessage };
}

// ---- Host → user gift requests ----------------------------------------------
// Recorded only so admins can see them (GET /admin/gifts/requests); the
// request itself is still just a prompt on the user's screen.

export async function recordGiftRequest(hostId: string, userId: string, suggestedGiftId: string | null, note: string | null) {
  const [request] = await db.insert(giftRequests).values({ hostId, userId, suggestedGiftId, note }).returning();
  return request;
}

async function respondToLatestGiftRequest(hostId: string, userId: string, status: "accepted" | "declined"): Promise<void> {
  const [latest] = await db
    .select()
    .from(giftRequests)
    .where(and(eq(giftRequests.hostId, hostId), eq(giftRequests.userId, userId), eq(giftRequests.status, "pending")))
    .orderBy(desc(giftRequests.createdAt))
    .limit(1);
  if (!latest) return;
  await db.update(giftRequests).set({ status, respondedAt: new Date() }).where(eq(giftRequests.id, latest.id));
}

// The user sent this host a gift — the host's latest open request counts as answered.
export async function markGiftRequestAccepted(hostId: string, userId: string): Promise<void> {
  await respondToLatestGiftRequest(hostId, userId, "accepted");
}

export async function markGiftRequestDeclined(hostId: string, userId: string): Promise<void> {
  await respondToLatestGiftRequest(hostId, userId, "declined");
}

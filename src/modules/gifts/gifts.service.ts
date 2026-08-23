import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { giftContextEnum, giftTransactions, gifts } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { getUserById } from "../users/users.service";
import { getCurrentCommissionBasisPoints, getCurrentPaisePerBean, transferUserToHost } from "../wallet/wallet.service";

type Gift = typeof gifts.$inferSelect;
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
  const commissionBasisPointsSnapshot = await getCurrentCommissionBasisPoints();
  const paisePerBeanSnapshot = await getCurrentPaisePerBean();
  const price = gift.pricePaise;
  const commissionAmount = Math.floor((price * commissionBasisPointsSnapshot) / 10_000);
  const netToHost = price - commissionAmount;
  const beans = Math.floor(netToHost / paisePerBeanSnapshot);

  return db.transaction(async (tx) => {
    const [giftTxn] = await tx
      .insert(giftTransactions)
      .values({
        senderId,
        recipientId,
        giftId,
        context,
        contextId,
        pricePaiseSnapshot: price,
        commissionBasisPointsSnapshot,
        paisePerBeanSnapshot,
        beansCredited: beans,
      })
      .returning();

    await transferUserToHost(tx, {
      userId: senderId,
      hostId: recipientId,
      amountPaise: price,
      beans,
      referenceType: "gift",
      referenceId: giftTxn.id,
      debitIdempotencyKey: `gift:${giftTxn.id}:debit`,
      creditIdempotencyKey: `gift:${giftTxn.id}:credit`,
    });

    return { ...giftTxn, gift };
  });
}

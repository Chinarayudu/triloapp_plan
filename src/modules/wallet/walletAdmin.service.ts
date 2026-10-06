import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { calls, ledgerEntries, walletAdjustments, wallets } from "../../db/schema";
import { writeAuditLog } from "../../lib/auditLog";
import { AppError } from "../../lib/errors";
import { getUserById } from "../users/users.service";

// Admin view of a user's wallet, and admin balance adjustments (refunds and
// corrections). Money moves through the ledger exactly like every other
// wallet change: wallet row locked, balance updated, one ledger row — all in
// one transaction.

type LedgerReferenceType = (typeof ledgerEntries.$inferSelect)["referenceType"];
export type WalletTransactionType = "recharge" | "call" | "gift" | "message" | "refund" | "adjustment";

const TRANSACTION_TYPE: Record<LedgerReferenceType, WalletTransactionType> = {
  recharge: "recharge",
  call_billing: "call",
  gift: "gift",
  chat_message: "message",
  refund: "refund",
  adjustment: "adjustment",
  // Dev/test credits (POST /wallet/dev-credit, never in production) read as adjustments.
  dev_credit: "adjustment",
  // Host-wallet-only types; listed so the map is complete.
  commission: "adjustment",
  withdrawal: "adjustment",
};

async function requireUserAccount(userId: string) {
  const user = await getUserById(userId);
  if (!user || user.role !== "user") throw new AppError(404, "User not found");
  return user;
}

export async function getUserWalletForAdmin(userId: string, page: number, pageSize: number) {
  await requireUserAccount(userId);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!wallet) throw new Error(`No wallet row for user ${userId}`);

  const ownWallet = and(eq(ledgerEntries.walletType, "user"), eq(ledgerEntries.ownerId, userId));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(ledgerEntries)
      .where(ownWallet)
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(ledgerEntries).where(ownWallet),
  ]);

  // Adjustments and refunds carry the admin's reason and free-text reference.
  const adjustmentIds = rows
    .filter((r) => r.referenceType === "adjustment" || r.referenceType === "refund")
    .map((r) => r.referenceId)
    .filter((id): id is string => id !== null);
  const adjustments = adjustmentIds.length
    ? await db.select().from(walletAdjustments).where(inArray(walletAdjustments.id, adjustmentIds))
    : [];

  const transactions = rows.map((r) => {
    const adjustment = adjustments.find((a) => a.id === r.referenceId);
    return {
      id: r.id,
      type: TRANSACTION_TYPE[r.referenceType],
      // Signed: positive adds to the balance, negative takes from it.
      amountPaise: r.direction === "credit" ? r.amount : -r.amount,
      balanceAfterPaise: r.balanceAfter,
      reference: adjustment ? adjustment.reference : r.referenceId,
      reason: adjustment?.reason ?? null,
      createdAt: r.createdAt,
    };
  });

  return { balancePaise: wallet.balancePaise, transactions, total, page, pageSize, hasMore: page * pageSize < total };
}

// A positive amount credits the wallet (a refund when `reference` is one of
// this user's calls, otherwise a goodwill adjustment); a negative amount
// corrects it down, and is refused if it would take the balance below ₹0.
export async function adjustUserWallet(
  adminId: string,
  userId: string,
  amountPaise: number,
  reason: string,
  reference: string | null,
) {
  await requireUserAccount(userId);

  let isRefund = false;
  if (reference && /^[0-9a-f-]{36}$/i.test(reference)) {
    const [call] = await db.select({ userId: calls.userId }).from(calls).where(eq(calls.id, reference)).limit(1);
    if (call && call.userId !== userId) throw new AppError(400, "That call belongs to a different user");
    isRefund = Boolean(call) && amountPaise > 0;
  }
  const referenceType: LedgerReferenceType = isRefund ? "refund" : "adjustment";

  const result = await db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (!wallet) throw new Error(`No wallet row for user ${userId}`);

    const balanceBeforePaise = wallet.balancePaise;
    const balanceAfterPaise = balanceBeforePaise + amountPaise;
    if (balanceAfterPaise < 0) {
      throw new AppError(
        422,
        `This would take the balance below ₹0 — the balance is ₹${(balanceBeforePaise / 100).toFixed(2)}, so at most ₹${(balanceBeforePaise / 100).toFixed(2)} can be taken off`,
      );
    }

    const [adjustment] = await tx
      .insert(walletAdjustments)
      .values({ userId, adminId, amountPaise, reason, reference, balanceAfterPaise })
      .returning();
    await tx.update(wallets).set({ balancePaise: balanceAfterPaise, updatedAt: new Date() }).where(eq(wallets.userId, userId));
    await tx.insert(ledgerEntries).values({
      walletType: "user",
      ownerId: userId,
      direction: amountPaise > 0 ? "credit" : "debit",
      amount: Math.abs(amountPaise),
      referenceType,
      referenceId: adjustment.id,
      balanceAfter: balanceAfterPaise,
      idempotencyKey: `admin-adjustment:${adjustment.id}`,
    });
    return { adjustment, balanceBeforePaise, balanceAfterPaise };
  });

  await writeAuditLog(adminId, `wallet.${referenceType}`, "user", userId, {
    adjustmentId: result.adjustment.id,
    amountPaise,
    reason,
    reference,
    before: { balancePaise: result.balanceBeforePaise },
    after: { balancePaise: result.balanceAfterPaise },
  });

  return {
    adjustmentId: result.adjustment.id,
    type: referenceType,
    amountPaise,
    reason,
    reference,
    balanceBeforePaise: result.balanceBeforePaise,
    balanceAfterPaise: result.balanceAfterPaise,
    createdAt: result.adjustment.createdAt,
  };
}

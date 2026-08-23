import { desc, eq, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { beansEarnConfigs, commissionConfigs, hostWallets, ledgerEntries, wallets } from "../../db/schema";
import { AppError } from "../../lib/errors";

// The type of the `tx` a db.transaction(async (tx) => ...) callback
// receives — extracted this way so transferUserToHost can be called from
// inside a caller's own transaction (calls.service.ts's billing tick,
// gifts.service.ts's sendGift) without importing a drizzle internal type
// name directly.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LedgerReferenceType =
  | "recharge"
  | "call_billing"
  | "gift"
  | "commission"
  | "withdrawal"
  | "refund"
  | "adjustment"
  | "dev_credit";

export async function getCurrentCommissionBasisPoints(): Promise<number> {
  const [row] = await db
    .select()
    .from(commissionConfigs)
    .where(lte(commissionConfigs.effectiveFrom, new Date()))
    .orderBy(desc(commissionConfigs.effectiveFrom))
    .limit(1);
  if (!row) throw new Error("No commission config seeded — run `npm run db:seed`");
  return row.basisPoints;
}

export async function getCurrentPaisePerBean(): Promise<number> {
  const [row] = await db
    .select()
    .from(beansEarnConfigs)
    .where(lte(beansEarnConfigs.effectiveFrom, new Date()))
    .orderBy(desc(beansEarnConfigs.effectiveFrom))
    .limit(1);
  if (!row) throw new Error("No beans earn config seeded — run `npm run db:seed`");
  return row.paisePerBean;
}

export async function getUserWalletBalance(userId: string): Promise<number> {
  const [row] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!row) throw new Error(`No wallet row for user ${userId}`);
  return row.balancePaise;
}

export async function getHostBeanBalance(hostId: string): Promise<number> {
  const [row] = await db.select().from(hostWallets).where(eq(hostWallets.hostId, hostId)).limit(1);
  if (!row) throw new Error(`No host wallet row for host ${hostId}`);
  return row.beanBalance;
}

export async function creditUserWallet(
  userId: string,
  amountPaise: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
  idempotencyKey: string,
): Promise<{ balanceAfter: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (!row) throw new Error(`No wallet row for user ${userId}`);

    const balanceAfter = row.balancePaise + amountPaise;
    await tx.update(wallets).set({ balancePaise: balanceAfter, updatedAt: new Date() }).where(eq(wallets.userId, userId));
    await tx.insert(ledgerEntries).values({
      walletType: "user",
      ownerId: userId,
      direction: "credit",
      amount: amountPaise,
      referenceType,
      referenceId,
      balanceAfter,
      idempotencyKey,
    });

    return { balanceAfter };
  });
}

// Takes the caller's own transaction (like transferUserToHost below) so a
// withdrawal request row and its beans debit commit atomically together —
// withdrawal.service.ts is the caller.
export async function debitHostBeans(
  tx: Tx,
  hostId: string,
  beans: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
  idempotencyKey: string,
): Promise<{ balanceAfter: number }> {
  const [row] = await tx.select().from(hostWallets).where(eq(hostWallets.hostId, hostId)).for("update");
  if (!row) throw new Error(`No host wallet row for host ${hostId}`);
  if (row.beanBalance < beans) throw new AppError(402, "Insufficient bean balance");

  const balanceAfter = row.beanBalance - beans;
  await tx.update(hostWallets).set({ beanBalance: balanceAfter, updatedAt: new Date() }).where(eq(hostWallets.hostId, hostId));
  await tx.insert(ledgerEntries).values({
    walletType: "host",
    ownerId: hostId,
    direction: "debit",
    amount: beans,
    referenceType,
    referenceId,
    balanceAfter,
    idempotencyKey,
  });

  return { balanceAfter };
}

// Reverses a debit (a rejected or failed withdrawal, BR-EARN-06) — same
// tx-composable shape as debitHostBeans above.
export async function creditHostBeans(
  tx: Tx,
  hostId: string,
  beans: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
  idempotencyKey: string,
): Promise<{ balanceAfter: number }> {
  const [row] = await tx.select().from(hostWallets).where(eq(hostWallets.hostId, hostId)).for("update");
  if (!row) throw new Error(`No host wallet row for host ${hostId}`);

  const balanceAfter = row.beanBalance + beans;
  await tx.update(hostWallets).set({ beanBalance: balanceAfter, updatedAt: new Date() }).where(eq(hostWallets.hostId, hostId));
  await tx.insert(ledgerEntries).values({
    walletType: "host",
    ownerId: hostId,
    direction: "credit",
    amount: beans,
    referenceType,
    referenceId,
    balanceAfter,
    idempotencyKey,
  });

  return { balanceAfter };
}

// The one primitive that moves money from a user's currency wallet to a
// host's bean wallet — debit, credit, and both ledger entries, as a single
// atomic unit within the caller's own transaction. Call billing (a tick)
// and gifting both need exactly this, and sharing it means the commission/
// atomicity logic can't drift between the two — see calls.service.ts's
// history for why "two separate transactions" was a real bug here, not a
// hypothetical one.
//
// Idempotency keys are the caller's responsibility, not derived here: a
// call's billing tick needs one key per tick against the same callId,
// while a gift needs exactly one key against its own transaction id —
// deriving a "one true format" here would be wrong for one of the two.
export async function transferUserToHost(
  tx: Tx,
  params: {
    userId: string;
    hostId: string;
    amountPaise: number;
    beans: number;
    referenceType: LedgerReferenceType;
    referenceId: string;
    debitIdempotencyKey: string;
    creditIdempotencyKey: string;
  },
): Promise<{ userBalanceAfter: number; hostBalanceAfter: number }> {
  const { userId, hostId, amountPaise, beans, referenceType, referenceId, debitIdempotencyKey, creditIdempotencyKey } =
    params;

  const [userWallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
  if (!userWallet) throw new Error(`No wallet row for user ${userId}`);
  if (userWallet.balancePaise < amountPaise) throw new AppError(402, "Insufficient wallet balance");

  const userBalanceAfter = userWallet.balancePaise - amountPaise;
  await tx.update(wallets).set({ balancePaise: userBalanceAfter, updatedAt: new Date() }).where(eq(wallets.userId, userId));
  await tx.insert(ledgerEntries).values({
    walletType: "user",
    ownerId: userId,
    direction: "debit",
    amount: amountPaise,
    referenceType,
    referenceId,
    balanceAfter: userBalanceAfter,
    idempotencyKey: debitIdempotencyKey,
  });

  const [hostWallet] = await tx.select().from(hostWallets).where(eq(hostWallets.hostId, hostId)).for("update");
  if (!hostWallet) throw new Error(`No host wallet row for host ${hostId}`);

  const hostBalanceAfter = hostWallet.beanBalance + beans;
  await tx
    .update(hostWallets)
    .set({ beanBalance: hostBalanceAfter, updatedAt: new Date() })
    .where(eq(hostWallets.hostId, hostId));
  await tx.insert(ledgerEntries).values({
    walletType: "host",
    ownerId: hostId,
    direction: "credit",
    amount: beans,
    referenceType,
    referenceId,
    balanceAfter: hostBalanceAfter,
    idempotencyKey: creditIdempotencyKey,
  });

  return { userBalanceAfter, hostBalanceAfter };
}

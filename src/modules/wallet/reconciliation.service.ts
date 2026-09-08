import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { hostWallets, ledgerEntries, wallets } from "../../db/schema";
import { logger } from "../../lib/logger";

// BACKEND_PLAN.md §1 "Reconciliation job" (Phase 11) — the ledger is the
// source of truth, the balance columns on wallets/hostWallets are a cached
// derived value (creditUserWallet et al. keep them in lockstep on every
// write, but this is the independent check that they actually stayed in
// sync — the whole point of a cache is that it's fast, not that it's
// trusted blindly forever).
export type WalletDrift = { ownerId: string; cachedBalance: number; computedBalance: number; driftAmount: number };

// signedSum is the same "credit adds, debit subtracts" reduction as the
// ledger itself, expressed once in SQL rather than pulled row-by-row into
// JS and summed there — this table can get large, and the DB is much
// better at this aggregation than Node would be.
const signedSum = sql<number>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)::int`;

export async function reconcileUserWallets(): Promise<WalletDrift[]> {
  const rows = await db
    .select({ ownerId: wallets.userId, cachedBalance: wallets.balancePaise, computedBalance: signedSum })
    .from(wallets)
    .leftJoin(ledgerEntries, and(eq(ledgerEntries.ownerId, wallets.userId), eq(ledgerEntries.walletType, "user")))
    .groupBy(wallets.userId, wallets.balancePaise);

  return rows
    .filter((row) => row.cachedBalance !== row.computedBalance)
    .map((row) => ({ ...row, driftAmount: row.cachedBalance - row.computedBalance }));
}

export async function reconcileHostWallets(): Promise<WalletDrift[]> {
  const rows = await db
    .select({ ownerId: hostWallets.hostId, cachedBalance: hostWallets.beanBalance, computedBalance: signedSum })
    .from(hostWallets)
    .leftJoin(ledgerEntries, and(eq(ledgerEntries.ownerId, hostWallets.hostId), eq(ledgerEntries.walletType, "host")))
    .groupBy(hostWallets.hostId, hostWallets.beanBalance);

  return rows
    .filter((row) => row.cachedBalance !== row.computedBalance)
    .map((row) => ({ ...row, driftAmount: row.cachedBalance - row.computedBalance }));
}

export async function reconcileAllWallets(): Promise<{ userDrift: WalletDrift[]; hostDrift: WalletDrift[] }> {
  const [userDrift, hostDrift] = await Promise.all([reconcileUserWallets(), reconcileHostWallets()]);
  return { userDrift, hostDrift };
}

// Logged at error level deliberately — any drift here means a wallet
// balance and its own ledger history disagree, which should never happen
// if every mutation went through wallet.service.ts's helpers; this is the
// backstop that catches it if one didn't (a direct SQL fix, a bug, a
// crashed transaction that partially committed).
export function startReconciliationSweep(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    void reconcileAllWallets()
      .then(({ userDrift, hostDrift }) => {
        if (userDrift.length > 0 || hostDrift.length > 0) {
          logger.error({ userDrift, hostDrift }, "Wallet reconciliation found drift between cached balances and the ledger");
        }
      })
      .catch((err) => logger.error({ err }, "Wallet reconciliation sweep failed"));
  }, intervalMs).unref();
}

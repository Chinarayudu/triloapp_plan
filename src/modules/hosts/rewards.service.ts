import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { hostRewardConfigs, hostRewardPayouts, hostRewardSettlements, ledgerEntries, users } from "../../db/schema";
import { writeAuditLog } from "../../lib/auditLog";
import { addDays, dateInTimeZone, DEFAULT_TIME_ZONE, startOfDayInTimeZone } from "../../lib/dayBounds";
import { logger } from "../../lib/logger";
import { createNotification } from "../notifications/notifications.service";
import { creditHostBeans } from "../wallet/wallet.service";

// Host daily and weekly rewards ("Daily Wins" / "Weekly Wins"). Hosts are
// ranked by the beans they earned in the period — an India-time calendar day,
// or Monday 00:00 to the next Monday 00:00 IST — from calls, gifts and paid
// messages only (not admin adjustments, not earlier rewards). A host must
// earn at least the config's minQualifyingBeans to be ranked. When a period
// closes, rank N's reward goes to the Nth-ranked host as a ledger credit to
// their bean balance. Rewards don't count toward host level
// (creditHostBeans never touches lifetimeEarnedBeans).

export type RewardPeriod = "daily" | "weekly";
export type RewardTier = { rank: number; rewardBeans: number };
export type RewardConfig = { id: string | null; enabled: boolean; minQualifyingBeans: number; tiers: RewardTier[] };

const RANKED_REFERENCE_TYPES = ["call_billing", "gift", "chat_message"] as const;
// A billing tick's ledger row is stamped when its transaction starts, so one
// that starts at 23:59:59 can commit just after midnight. Waiting this long
// after a period ends before settling it means no such row is missed.
const SETTLE_GRACE_MS = 5 * 60_000;
// How far back the sweep looks for unsettled periods (covers the server being
// down for a while). Older periods are never settled automatically.
const DAILY_LOOKBACK = 3;
const WEEKLY_LOOKBACK = 2;

const NO_REWARDS: RewardConfig = { id: null, enabled: false, minQualifyingBeans: 0, tiers: [] };

export function periodContaining(period: RewardPeriod, at: Date): { start: Date; end: Date } {
  const today = dateInTimeZone(at, DEFAULT_TIME_ZONE);
  if (period === "daily") {
    return { start: startOfDayInTimeZone(today, DEFAULT_TIME_ZONE), end: startOfDayInTimeZone(addDays(today, 1), DEFAULT_TIME_ZONE) };
  }
  const [y, m, d] = today.split("-").map(Number);
  const daysSinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const monday = addDays(today, -daysSinceMonday);
  return { start: startOfDayInTimeZone(monday, DEFAULT_TIME_ZONE), end: startOfDayInTimeZone(addDays(monday, 7), DEFAULT_TIME_ZONE) };
}

// The config in force at `at`. No row = rewards off.
export async function getRewardConfig(period: RewardPeriod, at: Date = new Date()): Promise<RewardConfig> {
  const [row] = await db
    .select()
    .from(hostRewardConfigs)
    .where(and(eq(hostRewardConfigs.period, period), lte(hostRewardConfigs.effectiveFrom, at)))
    .orderBy(desc(hostRewardConfigs.effectiveFrom))
    .limit(1);
  if (!row) return NO_REWARDS;
  return { id: row.id, enabled: row.enabled, minQualifyingBeans: row.minQualifyingBeans, tiers: row.tiers };
}

export async function setRewardConfig(
  adminId: string,
  period: RewardPeriod,
  config: { enabled: boolean; minQualifyingBeans: number; tiers: RewardTier[] },
  reason: string | undefined,
): Promise<RewardConfig> {
  const previous = await getRewardConfig(period);
  // Server clock, not the DB default — same reasoning as setAppSettings.
  const [row] = await db
    .insert(hostRewardConfigs)
    .values({ period, ...config, effectiveFrom: new Date() })
    .returning();
  await writeAuditLog(adminId, "config.host_rewards.create", "host_reward_config", row.id, {
    period,
    before: previous,
    after: config,
    reason,
  });
  return { id: row.id, ...config };
}

// Every qualifying, active host, best first. Equal beans are ordered by host
// id — arbitrary but stable, so the same period always ranks the same way.
type DbOrTx = Pick<typeof db, "select">;
async function rankHosts(conn: DbOrTx, start: Date, end: Date, minQualifyingBeans: number) {
  const beans = sql<string>`sum(${ledgerEntries.amount})`;
  const rows = await conn
    .select({ hostId: ledgerEntries.ownerId, beans })
    .from(ledgerEntries)
    .innerJoin(users, eq(users.id, ledgerEntries.ownerId))
    .where(
      and(
        eq(ledgerEntries.walletType, "host"),
        eq(ledgerEntries.direction, "credit"),
        inArray(ledgerEntries.referenceType, [...RANKED_REFERENCE_TYPES]),
        gte(ledgerEntries.createdAt, start),
        lt(ledgerEntries.createdAt, end),
        eq(users.status, "active"),
      ),
    )
    .groupBy(ledgerEntries.ownerId)
    .having(sql`${beans} >= ${Math.max(1, minQualifyingBeans)}`)
    .orderBy(desc(beans), asc(ledgerEntries.ownerId));
  return rows.map((r, i) => ({ rank: i + 1, hostId: r.hostId, beans: Number(r.beans) }));
}

async function hostBeansInPeriod(hostId: string, start: Date, end: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.ownerId, hostId),
        eq(ledgerEntries.walletType, "host"),
        eq(ledgerEntries.direction, "credit"),
        inArray(ledgerEntries.referenceType, [...RANKED_REFERENCE_TYPES]),
        gte(ledgerEntries.createdAt, start),
        lt(ledgerEntries.createdAt, end),
      ),
    );
  return Number(row?.total ?? 0);
}

// Host app's Daily Wins / Weekly Wins sheets: the reward table, and where this
// host stands in the period running now.
export async function getHostRewards(hostId: string, now: Date = new Date()) {
  const result: Record<RewardPeriod, unknown> = { daily: null, weekly: null };
  for (const period of ["daily", "weekly"] as const) {
    const config = await getRewardConfig(period, now);
    const { start, end } = periodContaining(period, now);
    const myBeans = await hostBeansInPeriod(hostId, start, end);
    const standing = config.enabled ? (await rankHosts(db, start, end, config.minQualifyingBeans)).find((r) => r.hostId === hostId) : undefined;
    const myRank = standing?.rank ?? null;
    result[period] = {
      enabled: config.enabled,
      periodStart: start,
      periodEnd: end,
      minQualifyingBeans: config.minQualifyingBeans,
      tiers: config.tiers,
      totalRewardBeans: config.tiers.reduce((sum, t) => sum + t.rewardBeans, 0),
      myBeans,
      // null until the host has earned at least minQualifyingBeans (and 1 bean).
      myRank,
      // What this host would win if the period ended now; 0 if ranked below the table.
      myRewardBeans: config.tiers.find((t) => t.rank === myRank)?.rewardBeans ?? 0,
      beansToQualify: Math.max(0, Math.max(1, config.minQualifyingBeans) - myBeans),
    };
  }
  return result;
}

// Settles one closed period exactly once: the settlement row, every payout row
// and every bean credit commit together or not at all. Returns null if another
// sweep (or another instance) already settled it.
export async function settleRewardPeriod(period: RewardPeriod, start: Date, end: Date) {
  const config = await getRewardConfig(period, end);
  const winners = await db.transaction(async (tx) => {
    const [settlement] = await tx
      .insert(hostRewardSettlements)
      .values({ period, periodStart: start, periodEnd: end, configId: config.id })
      .onConflictDoNothing()
      .returning();
    if (!settlement) return null;
    if (!config.enabled) return [];

    const standings = await rankHosts(tx, start, end, config.minQualifyingBeans);
    const paid: Array<{ hostId: string; rank: number; rewardBeans: number }> = [];
    for (const tier of config.tiers) {
      const winner = standings[tier.rank - 1];
      if (!winner) break;
      const [payout] = await tx
        .insert(hostRewardPayouts)
        .values({ settlementId: settlement.id, hostId: winner.hostId, rank: tier.rank, beansEarned: winner.beans, rewardBeans: tier.rewardBeans })
        .returning();
      await creditHostBeans(tx, winner.hostId, tier.rewardBeans, "host_reward", payout.id, `host-reward:${settlement.id}:${tier.rank}`);
      paid.push({ hostId: winner.hostId, rank: tier.rank, rewardBeans: tier.rewardBeans });
    }
    return paid;
  });
  if (winners === null) return null;

  // After commit: a failed notification must never undo a paid reward.
  for (const w of winners) {
    const label = period === "daily" ? "Daily" : "Weekly";
    await createNotification(w.hostId, "host_reward", `${label} reward won!`, `You ranked #${w.rank} — ${w.rewardBeans} beans added to your balance`).catch(
      (err) => logger.error({ err, hostId: w.hostId }, "Could not notify a host of their reward"),
    );
  }
  if (winners.length > 0) logger.info({ period, start, winners: winners.length }, "Settled host rewards");
  return winners;
}

// Settles every recently closed, not-yet-settled daily and weekly period.
// Safe to run on every instance at once (settleRewardPeriod settles once).
export async function settleClosedRewardPeriods(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - SETTLE_GRACE_MS);
  for (const [period, lookback] of [["daily", DAILY_LOOKBACK], ["weekly", WEEKLY_LOOKBACK]] as const) {
    let { start } = periodContaining(period, cutoff);
    for (let i = 0; i < lookback; i++) {
      const previous = periodContaining(period, new Date(start.getTime() - 1));
      await settleRewardPeriod(period, previous.start, previous.end);
      start = previous.start;
    }
  }
}

// .unref() like the other sweeps — never keeps the process alive by itself.
export function startHostRewardSweep(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    void settleClosedRewardPeriods().catch((err) => logger.error({ err }, "Host reward sweep failed"));
  }, intervalMs).unref();
}

// Host app reward history: this host's past wins, newest first.
export async function listHostRewardPayouts(hostId: string, page: number, pageSize: number) {
  const rows = await db
    .select({
      id: hostRewardPayouts.id,
      period: hostRewardSettlements.period,
      periodStart: hostRewardSettlements.periodStart,
      periodEnd: hostRewardSettlements.periodEnd,
      rank: hostRewardPayouts.rank,
      beansEarned: hostRewardPayouts.beansEarned,
      rewardBeans: hostRewardPayouts.rewardBeans,
      paidAt: hostRewardPayouts.createdAt,
    })
    .from(hostRewardPayouts)
    .innerJoin(hostRewardSettlements, eq(hostRewardSettlements.id, hostRewardPayouts.settlementId))
    .where(eq(hostRewardPayouts.hostId, hostId))
    .orderBy(desc(hostRewardPayouts.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { payouts: rows, page, pageSize };
}

// Admin: live standings for the period running now (who would win if it ended now).
export async function getRewardStandingsForAdmin(period: RewardPeriod, now: Date = new Date()) {
  const config = await getRewardConfig(period, now);
  const { start, end } = periodContaining(period, now);
  const standings = (await rankHosts(db, start, end, config.minQualifyingBeans)).slice(0, Math.max(config.tiers.length, 50));
  const names = standings.length
    ? await db.select({ id: users.id, name: users.name, phone: users.phone }).from(users).where(inArray(users.id, standings.map((s) => s.hostId)))
    : [];
  return {
    period,
    periodStart: start,
    periodEnd: end,
    config,
    standings: standings.map((s) => ({
      ...s,
      name: names.find((n) => n.id === s.hostId)?.name ?? null,
      phone: names.find((n) => n.id === s.hostId)?.phone ?? null,
      rewardBeans: config.tiers.find((t) => t.rank === s.rank)?.rewardBeans ?? 0,
    })),
  };
}

// Admin: settled periods with who was paid what.
export async function listRewardSettlementsForAdmin(period: RewardPeriod, page: number, pageSize: number) {
  const settlements = await db
    .select()
    .from(hostRewardSettlements)
    .where(eq(hostRewardSettlements.period, period))
    .orderBy(desc(hostRewardSettlements.periodStart))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  if (settlements.length === 0) return { settlements: [], page, pageSize };

  const payouts = await db
    .select({
      settlementId: hostRewardPayouts.settlementId,
      hostId: hostRewardPayouts.hostId,
      name: users.name,
      rank: hostRewardPayouts.rank,
      beansEarned: hostRewardPayouts.beansEarned,
      rewardBeans: hostRewardPayouts.rewardBeans,
    })
    .from(hostRewardPayouts)
    .innerJoin(users, eq(users.id, hostRewardPayouts.hostId))
    .where(inArray(hostRewardPayouts.settlementId, settlements.map((s) => s.id)))
    .orderBy(asc(hostRewardPayouts.rank));
  return {
    settlements: settlements.map((s) => ({
      ...s,
      payouts: payouts.filter((p) => p.settlementId === s.id),
    })),
    page,
    pageSize,
  };
}

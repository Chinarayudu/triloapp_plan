import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { callBillingTicks, calls, giftTransactions, gifts, hostWallets, ledgerEntries, liveBroadcasts, users } from "../../db/schema";

type GiftContext = "call" | "chat" | "live";

// gift_transactions.context is nullable (a gift isn't required to be tied
// to a call/chat/live instance) — those NULL-context gifts still count
// toward the generic "gifts" bucket, just never toward "live".
function giftContextFilter(contexts: readonly GiftContext[]) {
  return contexts.includes("call" as GiftContext) || contexts.includes("chat" as GiftContext)
    ? or(inArray(giftTransactions.context, contexts), isNull(giftTransactions.context))
    : inArray(giftTransactions.context, contexts);
}
import { getHostRatingSummary } from "../calls/ratings.service";
import { isOnline } from "../hosts/presence.store";
import { getActiveWithdrawalPolicy } from "../withdrawals/withdrawal.service";
import { getCurrentPaisePerBean } from "./wallet.service";

// This system has no per-user timezone concept yet (same simplification
// noted on notification_preferences' DND hours) — "today"/"this month"
// boundaries below are UTC-day-aligned, not the host's local day.
function startOfUtcDay(daysAgo = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function startOfUtcMonth(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  return d;
}

async function sumHostLedgerCredits(hostId: string, since: Date, until?: Date): Promise<number> {
  const conditions = [
    eq(ledgerEntries.ownerId, hostId),
    eq(ledgerEntries.walletType, "host"),
    eq(ledgerEntries.direction, "credit"),
    gte(ledgerEntries.createdAt, since),
  ];
  if (until) conditions.push(lt(ledgerEntries.createdAt, until));

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

// Home screen summary (Host app design follow-up).
export async function getHostDashboard(hostId: string) {
  const paisePerBean = await getCurrentPaisePerBean();
  const todayStart = startOfUtcDay();

  const todayBeans = await sumHostLedgerCredits(hostId, todayStart);

  const [{ value: todayCallsCount }] = await db
    .select({ value: sql<number>`count(*)` })
    .from(calls)
    .where(and(eq(calls.hostId, hostId), eq(calls.status, "completed"), gte(calls.endedAt, todayStart)));

  const recentCalls = await db
    .select({
      id: calls.id,
      type: calls.type,
      status: calls.status,
      counterpartId: calls.userId,
      counterpartName: users.name,
      totalAmountPaise: calls.totalAmountPaise,
      totalBeans: calls.totalBeans,
      createdAt: calls.createdAt,
    })
    .from(calls)
    .innerJoin(users, eq(users.id, calls.userId))
    .where(eq(calls.hostId, hostId))
    .orderBy(desc(calls.createdAt))
    .limit(5);

  return {
    isOnline: isOnline(hostId),
    todayBeans,
    todayEarningsPaise: todayBeans * paisePerBean,
    todayCallsCount: Number(todayCallsCount),
    rating: await getHostRatingSummary(hostId),
    recentCalls,
  };
}

// Earnings tab (Host app design follow-up) — balance plus this-month source
// subtotals and a last-7-days daily series, both derived from ledger_entries
// (host wallet credits), converted to a paise display figure at the
// *current* earn rate — an approximation for display, since a given
// historical credit may have been struck at a different snapshotted rate.
export async function getHostEarningsSummary(hostId: string) {
  const paisePerBean = await getCurrentPaisePerBean();

  const [wallet] = await db.select().from(hostWallets).where(eq(hostWallets.hostId, hostId)).limit(1);
  const beanBalance = wallet?.beanBalance ?? 0;

  const monthStart = startOfUtcMonth();
  const callsBeans = await sumHostLedgerCreditsByReference(hostId, "call_billing", monthStart);
  const giftBeans = await sumGiftBeansBySource(hostId, monthStart, "gift");
  const liveBeans = await sumGiftBeansBySource(hostId, monthStart, "live");

  const last7Days: Array<{ date: string; beans: number; amountPaise: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfUtcDay(i);
    const dayEnd = startOfUtcDay(i - 1);
    const beans = await sumHostLedgerCredits(hostId, dayStart, dayEnd);
    last7Days.push({ date: dayStart.toISOString().slice(0, 10), beans, amountPaise: beans * paisePerBean });
  }

  return {
    beanBalance,
    availableBalancePaise: beanBalance * paisePerBean,
    bySource: {
      calls: { beans: callsBeans, amountPaise: callsBeans * paisePerBean },
      gifts: { beans: giftBeans, amountPaise: giftBeans * paisePerBean },
      live: { beans: liveBeans, amountPaise: liveBeans * paisePerBean },
    },
    last7Days,
  };
}

async function sumHostLedgerCreditsByReference(hostId: string, referenceType: "call_billing" | "gift", since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.ownerId, hostId),
        eq(ledgerEntries.walletType, "host"),
        eq(ledgerEntries.direction, "credit"),
        eq(ledgerEntries.referenceType, referenceType),
        gte(ledgerEntries.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

// "gift" bucket = gift_transactions with context in (call, chat, or none);
// "live" bucket = context = live — the History/Earnings screens split these
// into separate lines even though both are the same underlying gift-send flow.
async function sumGiftBeansBySource(hostId: string, since: Date, bucket: "gift" | "live"): Promise<number> {
  const contexts: GiftContext[] = bucket === "live" ? ["live"] : ["call", "chat"];
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${giftTransactions.beansCredited}), 0)` })
    .from(giftTransactions)
    .where(and(eq(giftTransactions.recipientId, hostId), giftContextFilter(contexts), gte(giftTransactions.createdAt, since)));
  return Number(row?.total ?? 0);
}

// Breakdown screen (Host app design follow-up) — gross earnings computed
// pre-commission from the same rows call/gift billing already writes
// (call_billing_ticks.amountPaise, gift_transactions.pricePaiseSnapshot),
// with commission recomputed from each row's own snapshotted
// commissionBasisPointsSnapshot so this can never drift from what was
// actually charged at the time, even if the global commission rate has
// since changed. TDS here is a *display estimate* (same tdsBasisPoints
// config withdrawal.service.ts uses for a real withdrawal) applied to
// period-gross — distinct from the real, per-request TDS deducted when
// beans are actually withdrawn.
export async function getHostEarningsBreakdown(hostId: string, from: Date, to: Date) {
  const [videoCalls, voiceCalls] = await Promise.all([
    sumCallGrossAndCommission(hostId, "video", from, to),
    sumCallGrossAndCommission(hostId, "voice", from, to),
  ]);
  const [gifts, liveStreams] = await Promise.all([
    sumGiftGrossAndCommission(hostId, ["call", "chat"] as GiftContext[], from, to),
    sumGiftGrossAndCommission(hostId, ["live"] as GiftContext[], from, to),
  ]);

  const grossEarningsPaise = videoCalls.gross + voiceCalls.gross + gifts.gross + liveStreams.gross;
  const platformCommissionPaise = videoCalls.commission + voiceCalls.commission + gifts.commission + liveStreams.commission;

  const policy = await getActiveWithdrawalPolicy();
  const tdsPaise = Math.floor((grossEarningsPaise * policy.tdsBasisPoints) / 10_000);
  const netPayablePaise = grossEarningsPaise - platformCommissionPaise - tdsPaise;

  return {
    grossEarningsPaise,
    bySource: {
      videoCalls: videoCalls.gross,
      voiceCalls: voiceCalls.gross,
      gifts: gifts.gross,
      liveStreams: liveStreams.gross,
    },
    deductions: { platformCommissionPaise, tdsPaise },
    netPayablePaise,
  };
}

async function sumCallGrossAndCommission(
  hostId: string,
  type: "video" | "voice",
  from: Date,
  to: Date,
): Promise<{ gross: number; commission: number }> {
  const [row] = await db
    .select({
      gross: sql<string>`coalesce(sum(${callBillingTicks.amountPaise}), 0)`,
      commission: sql<string>`coalesce(sum(floor(${callBillingTicks.amountPaise} * ${calls.commissionBasisPointsSnapshot} / 10000.0)), 0)`,
    })
    .from(callBillingTicks)
    .innerJoin(calls, eq(calls.id, callBillingTicks.callId))
    .where(
      and(
        eq(calls.hostId, hostId),
        eq(calls.type, type),
        gte(callBillingTicks.createdAt, from),
        lt(callBillingTicks.createdAt, to),
      ),
    );
  return { gross: Number(row?.gross ?? 0), commission: Number(row?.commission ?? 0) };
}

async function sumGiftGrossAndCommission(
  hostId: string,
  contexts: GiftContext[],
  from: Date,
  to: Date,
): Promise<{ gross: number; commission: number }> {
  const [row] = await db
    .select({
      gross: sql<string>`coalesce(sum(${giftTransactions.pricePaiseSnapshot}), 0)`,
      commission: sql<string>`coalesce(sum(floor(${giftTransactions.pricePaiseSnapshot} * ${giftTransactions.commissionBasisPointsSnapshot} / 10000.0)), 0)`,
    })
    .from(giftTransactions)
    .where(
      and(
        eq(giftTransactions.recipientId, hostId),
        giftContextFilter(contexts),
        gte(giftTransactions.createdAt, from),
        lt(giftTransactions.createdAt, to),
      ),
    );
  return { gross: Number(row?.gross ?? 0), commission: Number(row?.commission ?? 0) };
}

type HistoryItem =
  | { type: "call"; id: string; when: Date; callType: "video" | "voice"; status: string; counterpartId: string; amountPaise: number; beans: number }
  | { type: "gift"; id: string; when: Date; giftName: string; senderId: string; amountPaise: number; beans: number }
  | { type: "live"; id: string; when: Date; durationSeconds: number; peakViewers: number; amountPaise: number; beans: number };

// History screen's All/Calls/Gifts/Live tabs — merges three typed lists and
// sorts/paginates in application code, same pattern accountDetail.service.ts's
// getRecentActivity already uses for its own merged activity feed.
export async function getHostHistory(
  hostId: string,
  type: "all" | "calls" | "gifts" | "live",
  page: number,
  pageSize: number,
  from?: Date,
  to?: Date,
) {
  const items: HistoryItem[] = [];
  const dateBounds = (column: PgColumn) => {
    const bounds = [];
    if (from) bounds.push(gte(column, from));
    if (to) bounds.push(lt(column, to));
    return bounds;
  };

  if (type === "all" || type === "calls") {
    const callRows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.hostId, hostId), ...dateBounds(calls.createdAt)))
      .orderBy(desc(calls.createdAt))
      .limit(from || to ? 10_000 : 200);
    for (const c of callRows) {
      items.push({
        type: "call",
        id: c.id,
        when: c.createdAt,
        callType: c.type,
        status: c.status,
        counterpartId: c.userId,
        amountPaise: c.totalAmountPaise,
        beans: c.totalBeans,
      });
    }
  }

  if (type === "all" || type === "gifts") {
    const giftRows = await db
      .select({
        id: giftTransactions.id,
        createdAt: giftTransactions.createdAt,
        senderId: giftTransactions.senderId,
        pricePaiseSnapshot: giftTransactions.pricePaiseSnapshot,
        beansCredited: giftTransactions.beansCredited,
        giftName: gifts.name,
      })
      .from(giftTransactions)
      .innerJoin(gifts, eq(gifts.id, giftTransactions.giftId))
      .where(
        and(
          eq(giftTransactions.recipientId, hostId),
          giftContextFilter(["call", "chat"]),
          ...dateBounds(giftTransactions.createdAt),
        ),
      )
      .orderBy(desc(giftTransactions.createdAt))
      .limit(from || to ? 10_000 : 200);
    for (const g of giftRows) {
      items.push({
        type: "gift",
        id: g.id,
        when: g.createdAt,
        giftName: g.giftName,
        senderId: g.senderId,
        amountPaise: g.pricePaiseSnapshot,
        beans: g.beansCredited,
      });
    }
  }

  if (type === "all" || type === "live") {
    const broadcastRows = await db
      .select()
      .from(liveBroadcasts)
      .where(
        and(eq(liveBroadcasts.hostId, hostId), eq(liveBroadcasts.status, "ended"), ...dateBounds(liveBroadcasts.endedAt)),
      )
      .orderBy(desc(liveBroadcasts.endedAt))
      .limit(from || to ? 10_000 : 50);
    const paisePerBean = await getCurrentPaisePerBean();
    for (const b of broadcastRows) {
      const [{ total: beansTotal }] = await db
        .select({ total: sql<string>`coalesce(sum(${giftTransactions.beansCredited}), 0)` })
        .from(giftTransactions)
        .where(and(eq(giftTransactions.context, "live"), eq(giftTransactions.contextId, b.id)));
      const beans = Number(beansTotal ?? 0);
      items.push({
        type: "live",
        id: b.id,
        when: b.endedAt ?? b.startedAt,
        durationSeconds: b.endedAt ? Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 1000) : 0,
        peakViewers: b.peakViewerCount,
        amountPaise: beans * paisePerBean,
        beans,
      });
    }
  }

  items.sort((a, b) => b.when.getTime() - a.when.getTime());
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

function csvField(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function historyItemDetail(item: HistoryItem): string {
  switch (item.type) {
    case "call":
      return `${item.callType} call (${item.status})`;
    case "gift":
      return `Gift: ${item.giftName}`;
    case "live":
      return `Live stream (${item.durationSeconds}s, peak ${item.peakViewers} viewers)`;
  }
}

// v1 export (BR-EARN docs' "statement" ask) — reuses the exact same
// aggregation (getHostEarningsBreakdown) and transaction list
// (getHostHistory, given an explicit date range) the on-screen breakdown and
// history tabs already compute; this only formats them as a CSV instead of
// JSON. Generated on demand rather than persisted — regenerating is simple
// enough that there's no "previous statements" list to keep in sync.
export async function getHostEarningsStatementCsv(hostId: string, from: Date, to: Date): Promise<string> {
  const breakdown = await getHostEarningsBreakdown(hostId, from, to);
  const { items } = await getHostHistory(hostId, "all", 1, 10_000, from, to);

  const lines: string[] = [];
  lines.push("Trilo earnings statement");
  lines.push(`Period,${from.toISOString()},${to.toISOString()}`);
  lines.push("");
  lines.push("Gross earnings (paise),Platform commission (paise),TDS (paise),Net payable (paise)");
  lines.push(
    [breakdown.grossEarningsPaise, breakdown.deductions.platformCommissionPaise, breakdown.deductions.tdsPaise, breakdown.netPayablePaise].join(","),
  );
  lines.push("");
  lines.push("Date,Type,Details,Amount (paise),Beans");
  for (const item of items) {
    lines.push([item.when.toISOString(), item.type, csvField(historyItemDetail(item)), item.amountPaise, item.beans].join(","));
  }

  return lines.join("\n");
}

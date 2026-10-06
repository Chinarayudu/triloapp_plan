import { and, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { calls, chatMessages, giftTransactions, hostOnlineSessions, users } from "../../db/schema";
import { addDays, dayRangeInTimeZone } from "../../lib/dayBounds";
import { TICK_INTERVAL_MS } from "../calls/calls.service";
import { listOnlineHostIds } from "../hosts/presence.store";

// Admin dashboard insights (GET /admin/dashboard/insights). Revenue is on the
// same basis as GET /admin/dashboard's revenuePaise: what users paid for
// completed calls, gifts and paid messages.

const TOP_HOSTS = 5;

export async function getDashboardInsights(from: string, to: string, tz: string) {
  const rangeStart = dayRangeInTimeZone(from, tz).start;
  const rangeEnd = dayRangeInTimeZone(to, tz).end;
  // Grouped by position (group by 1): the time zone is a bound parameter, so
  // repeating the expression in GROUP BY wouldn't count as the same expression.
  const localDay = (column: PgColumn) => sql<string>`to_char((${column} at time zone ${tz})::date, 'YYYY-MM-DD')`;

  // Completed calls count on the day they last moved money — the same rule the dashboard uses.
  const completedInRange = and(eq(calls.status, "completed"), gte(calls.updatedAt, rangeStart), lt(calls.updatedAt, rangeEnd));
  const [callDays, giftDays, messageDays] = await Promise.all([
    db
      .select({
        date: localDay(calls.updatedAt),
        revenuePaise: sql<number>`coalesce(sum(${calls.totalAmountPaise}), 0)::int`,
        ticks: sql<number>`coalesce(sum(${calls.tickCount}), 0)::int`,
      })
      .from(calls)
      .where(completedInRange)
      .groupBy(sql`1`),
    db
      .select({ date: localDay(giftTransactions.createdAt), revenuePaise: sql<number>`coalesce(sum(${giftTransactions.pricePaiseSnapshot}), 0)::int` })
      .from(giftTransactions)
      .where(and(gte(giftTransactions.createdAt, rangeStart), lt(giftTransactions.createdAt, rangeEnd)))
      .groupBy(sql`1`),
    db
      .select({ date: localDay(chatMessages.createdAt), revenuePaise: sql<number>`coalesce(sum(${chatMessages.chargedPaise}), 0)::int` })
      .from(chatMessages)
      .where(and(gt(chatMessages.chargedPaise, 0), gte(chatMessages.createdAt, rangeStart), lt(chatMessages.createdAt, rangeEnd)))
      .groupBy(sql`1`),
  ]);

  const revenueSeries = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const callDay = callDays.find((d) => d.date === date);
    const revenuePaise =
      (callDay?.revenuePaise ?? 0) +
      (giftDays.find((d) => d.date === date)?.revenuePaise ?? 0) +
      (messageDays.find((d) => d.date === date)?.revenuePaise ?? 0);
    const callMinutes = Math.round(((callDay?.ticks ?? 0) * (TICK_INTERVAL_MS / 1000)) / 60);
    revenueSeries.push({ date, revenuePaise, callMinutes });
  }

  // Calls placed in the range, by type and by outcome.
  const createdInRange = and(gte(calls.createdAt, rangeStart), lt(calls.createdAt, rangeEnd));
  const [byType, byStatus, [{ avgCallSeconds }]] = await Promise.all([
    db.select({ type: calls.type, count: sql<number>`count(*)::int` }).from(calls).where(createdInRange).groupBy(calls.type),
    db.select({ status: calls.status, count: sql<number>`count(*)::int` }).from(calls).where(createdInRange).groupBy(calls.status),
    db
      .select({
        avgCallSeconds: sql<number>`coalesce(round(avg(extract(epoch from (${calls.endedAt} - ${calls.startedAt})))), 0)::int`,
      })
      .from(calls)
      .where(and(createdInRange, eq(calls.status, "completed"))),
  ]);
  const typeCount = (type: string) => byType.find((r) => r.type === type)?.count ?? 0;
  const statusCount = (status: string) => byStatus.find((r) => r.status === status)?.count ?? 0;
  const callsByStatus = { completed: statusCount("completed"), missed: statusCount("missed"), rejected: statusCount("rejected") };
  const decided = callsByStatus.completed + callsByStatus.missed + callsByStatus.rejected;

  // Online time from the presence sessions overlapping the range, clipped to it.
  const online = await db
    .select({
      hostId: hostOnlineSessions.hostId,
      onlineSeconds: sql<number>`coalesce(sum(extract(epoch from (
        least(coalesce(${hostOnlineSessions.endedAt}, now()), ${rangeEnd}) - greatest(${hostOnlineSessions.startedAt}, ${rangeStart})
      ))), 0)::int`,
    })
    .from(hostOnlineSessions)
    .where(
      and(lt(hostOnlineSessions.startedAt, rangeEnd), or(isNull(hostOnlineSessions.endedAt), gt(hostOnlineSessions.endedAt, rangeStart))),
    )
    .groupBy(hostOnlineSessions.hostId)
    .orderBy(sql`2 desc`)
    .limit(TOP_HOSTS);
  const hostNames = online.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, online.map((o) => o.hostId)))
    : [];

  return {
    from,
    to,
    revenueSeries,
    callsByType: { video: typeCount("video"), voice: typeCount("voice") },
    callsByStatus,
    missedRate: decided > 0 ? Math.round((callsByStatus.missed / decided) * 1000) / 1000 : 0,
    avgCallSeconds,
    hostsOnlineNow: listOnlineHostIds().length,
    topByOnlineTime: online.map((o) => ({
      hostId: o.hostId,
      hostName: hostNames.find((h) => h.id === o.hostId)?.name ?? "Unknown",
      onlineSeconds: o.onlineSeconds,
    })),
  };
}

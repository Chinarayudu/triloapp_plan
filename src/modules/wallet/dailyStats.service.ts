import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { calls, giftTransactions, hostOnlineSessions, ledgerEntries, liveBroadcasts } from "../../db/schema";
import { addDays, dayRangeInTimeZone } from "../../lib/dayBounds";
import { isOnline } from "../hosts/presence.store";
import { callDurationQuality } from "../calls/calls.service";
import { getAppSettings } from "../settings/appSettings.service";
import { getCurrentPaisePerBean } from "./wallet.service";

// Host app daily report. Earnings are on the same basis as /me/dashboard's
// todayEarningsPaise: the host's own share (beans credited to their wallet,
// i.e. after commission) converted at the current paise-per-bean rate.

const OTHER_EARNING_LABELS: Record<"chat_message" | "adjustment", string> = {
  chat_message: "Chat messages",
  adjustment: "Adjustment",
};

type Interval = { start: number; end: number; open: boolean };

// Everything the report needs for [from, to), fetched once so a 31-day
// summary is a handful of queries, not a handful per day.
async function fetchHostActivity(hostId: string, from: Date, to: Date) {
  const overlaps = (startCol: PgColumn, endCol: PgColumn) =>
    and(lt(startCol, to), or(isNull(endCol), gt(endCol, from)));

  const [sessions, answeredCalls, receivedCalls, broadcasts, callCredits, giftCredits, otherCredits, paisePerBean] =
    await Promise.all([
      db
        .select({ startedAt: hostOnlineSessions.startedAt, endedAt: hostOnlineSessions.endedAt })
        .from(hostOnlineSessions)
        .where(and(eq(hostOnlineSessions.hostId, hostId), overlaps(hostOnlineSessions.startedAt, hostOnlineSessions.endedAt))),
      db
        .select({ startedAt: calls.startedAt, endedAt: calls.endedAt })
        .from(calls)
        .where(and(eq(calls.hostId, hostId), isNotNull(calls.startedAt), overlaps(calls.startedAt, calls.endedAt))),
      db
        .select({ type: calls.type, status: calls.status, createdAt: calls.createdAt, startedAt: calls.startedAt, endedAt: calls.endedAt })
        .from(calls)
        .where(and(eq(calls.hostId, hostId), gte(calls.createdAt, from), lt(calls.createdAt, to))),
      db
        .select({ startedAt: liveBroadcasts.startedAt, endedAt: liveBroadcasts.endedAt })
        .from(liveBroadcasts)
        .where(and(eq(liveBroadcasts.hostId, hostId), overlaps(liveBroadcasts.startedAt, liveBroadcasts.endedAt))),
      db
        .select({ beans: ledgerEntries.amount, createdAt: ledgerEntries.createdAt, callType: calls.type })
        .from(ledgerEntries)
        .innerJoin(calls, eq(calls.id, ledgerEntries.referenceId))
        .where(and(hostCreditsBetween(hostId, from, to), eq(ledgerEntries.referenceType, "call_billing"))),
      db
        .select({ beans: ledgerEntries.amount, createdAt: ledgerEntries.createdAt, context: giftTransactions.context })
        .from(ledgerEntries)
        .innerJoin(giftTransactions, eq(giftTransactions.id, ledgerEntries.referenceId))
        .where(and(hostCreditsBetween(hostId, from, to), eq(ledgerEntries.referenceType, "gift"))),
      db
        .select({ beans: ledgerEntries.amount, createdAt: ledgerEntries.createdAt, referenceType: ledgerEntries.referenceType })
        .from(ledgerEntries)
        .where(and(hostCreditsBetween(hostId, from, to), inArray(ledgerEntries.referenceType, ["chat_message", "adjustment"]))),
      getCurrentPaisePerBean(),
    ]);

  return { sessions, answeredCalls, receivedCalls, broadcasts, callCredits, giftCredits, otherCredits, paisePerBean };
}

function hostCreditsBetween(hostId: string, from: Date, to: Date) {
  return and(
    eq(ledgerEntries.ownerId, hostId),
    eq(ledgerEntries.walletType, "host"),
    eq(ledgerEntries.direction, "credit"),
    gte(ledgerEntries.createdAt, from),
    lt(ledgerEntries.createdAt, to),
  );
}

type HostActivity = Awaited<ReturnType<typeof fetchHostActivity>>;

// Online time = presence sessions ∪ answered calls ∪ live broadcasts, since
// time in a call or on air counts as online even if the presence toggle
// wasn't on. Overlaps are merged so nothing is counted twice.
function onlineIntervals(activity: HostActivity, dayStart: Date, asOf: Date): Interval[] {
  const raw: Interval[] = [];
  const add = (startedAt: Date | null, endedAt: Date | null) => {
    if (!startedAt) return;
    const start = Math.max(startedAt.getTime(), dayStart.getTime());
    const end = Math.min(endedAt ? endedAt.getTime() : asOf.getTime(), asOf.getTime());
    if (end > start) raw.push({ start, end, open: endedAt === null });
  };
  for (const s of activity.sessions) add(s.startedAt, s.endedAt);
  for (const c of activity.answeredCalls) add(c.startedAt, c.endedAt);
  for (const b of activity.broadcasts) add(b.startedAt, b.endedAt);

  raw.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of raw) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) {
        last.end = interval.end;
        last.open = interval.open;
      } else if (interval.end === last.end) {
        last.open = last.open || interval.open;
      }
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function isWithin(at: Date, start: Date, end: Date): boolean {
  return at >= start && at < end;
}

function summarizeDay(hostId: string, activity: HostActivity, date: string, dayStart: Date, dayEnd: Date, now: Date) {
  const asOf = now < dayEnd ? now : dayEnd;
  const isToday = asOf === now;
  const toPaise = (beans: number) => beans * activity.paisePerBean;

  const intervals = onlineIntervals(activity, dayStart, asOf);
  const totalOnlineMs = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);

  // Calls "of the day" are the ones that came in that day; talk time is each
  // call's full length (up to now if still going).
  const dayCalls = activity.receivedCalls.filter((c) => isWithin(c.createdAt, dayStart, dayEnd));
  const answered = dayCalls.filter((c) => c.startedAt !== null);
  const callSeconds = (c: (typeof answered)[number]) => secondsBetween(c.startedAt!, c.endedAt ?? now);

  const callEarnings = (type: "video" | "voice") => {
    const ofType = answered.filter((c) => c.type === type);
    const beans = activity.callCredits
      .filter((e) => e.callType === type && isWithin(e.createdAt, dayStart, dayEnd))
      .reduce((sum, e) => sum + e.beans, 0);
    return { amountPaise: toPaise(beans), count: ofType.length, seconds: ofType.reduce((sum, c) => sum + callSeconds(c), 0) };
  };
  const videoCalls = callEarnings("video");
  const voiceCalls = callEarnings("voice");

  const dayGiftCredits = activity.giftCredits.filter((e) => isWithin(e.createdAt, dayStart, dayEnd));
  const regularGifts = dayGiftCredits.filter((e) => e.context !== "live");
  const liveGifts = dayGiftCredits.filter((e) => e.context === "live");
  const gifts = { amountPaise: toPaise(regularGifts.reduce((sum, e) => sum + e.beans, 0)), count: regularGifts.length };

  const dayBroadcasts = activity.broadcasts.filter((b) => isWithin(b.startedAt, dayStart, dayEnd));
  const liveStreams = {
    amountPaise: toPaise(liveGifts.reduce((sum, e) => sum + e.beans, 0)),
    count: dayBroadcasts.length,
    seconds: dayBroadcasts.reduce((sum, b) => sum + secondsBetween(b.startedAt, b.endedAt ?? now), 0),
  };

  const dayOtherCredits = activity.otherCredits.filter((e) => isWithin(e.createdAt, dayStart, dayEnd));
  const otherItems: Array<{ label: string; amountPaise: number }> = [];
  for (const referenceType of ["chat_message", "adjustment"] as const) {
    const beans = dayOtherCredits.filter((e) => e.referenceType === referenceType).reduce((sum, e) => sum + e.beans, 0);
    if (beans > 0) otherItems.push({ label: OTHER_EARNING_LABELS[referenceType], amountPaise: toPaise(beans) });
  }
  const other = {
    amountPaise: otherItems.reduce((sum, i) => sum + i.amountPaise, 0),
    count: dayOtherCredits.length,
    items: otherItems,
  };

  const talkSeconds = answered.reduce((sum, c) => sum + callSeconds(c), 0);
  const inCallOrLiveNow =
    activity.answeredCalls.some((c) => c.endedAt === null) || activity.broadcasts.some((b) => b.endedAt === null);

  return {
    date,
    online: {
      totalSeconds: Math.floor(totalOnlineMs / 1000),
      isOnlineNow: isOnline(hostId) || inCallOrLiveNow,
      asOf: asOf.toISOString(),
      sessions: intervals.map((i) => ({
        start: new Date(i.start).toISOString(),
        // Still running: the app keeps the timer going from asOf.
        end: i.open && isToday && i.end === asOf.getTime() ? null : new Date(i.end).toISOString(),
      })),
    },
    earnings: {
      totalPaise: videoCalls.amountPaise + voiceCalls.amountPaise + gifts.amountPaise + liveStreams.amountPaise + other.amountPaise,
      videoCalls,
      voiceCalls,
      gifts,
      liveStreams,
      other,
    },
    calls: {
      received: dayCalls.length,
      answered: answered.length,
      missed: dayCalls.filter((c) => c.status === "missed").length,
      rejected: dayCalls.filter((c) => c.status === "rejected").length,
      talkSeconds,
      avgCallSeconds: answered.length > 0 ? Math.round(talkSeconds / answered.length) : 0,
    },
  };
}

export async function getHostDailyStats(hostId: string, date: string, tz: string, now: Date = new Date()) {
  const { start, end } = dayRangeInTimeZone(date, tz);
  const [activity, settings] = await Promise.all([fetchHostActivity(hostId, start, end), getAppSettings()]);
  // The goal is admin-editable (settings/appSettings.service.ts), 6 hours by default.
  return { ...summarizeDay(hostId, activity, date, start, end, now), dailyGoalSeconds: settings.dailyGoalSeconds };
}

// One row per day from..to inclusive, zero days included.
export async function getHostDailySummary(hostId: string, from: string, to: string, tz: string, now: Date = new Date()) {
  const rangeStart = dayRangeInTimeZone(from, tz).start;
  const rangeEnd = dayRangeInTimeZone(to, tz).end;
  const activity = await fetchHostActivity(hostId, rangeStart, rangeEnd);

  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const { start, end } = dayRangeInTimeZone(date, tz);
    const day = summarizeDay(hostId, activity, date, start, end, now);
    days.push({
      date,
      earningsPaise: day.earnings.totalPaise,
      onlineSeconds: day.online.totalSeconds,
      callsCount: day.calls.answered,
    });
  }
  return { days };
}

// Admin host Performance tab (GET /admin/hosts/:id/stats/summary) — the same
// per-day numbers as the host's own daily report, added up over from..to.
export async function getHostRangeSummary(hostId: string, from: string, to: string, tz: string, now: Date = new Date()) {
  const rangeStart = dayRangeInTimeZone(from, tz).start;
  const rangeEnd = dayRangeInTimeZone(to, tz).end;
  const [activity, settings] = await Promise.all([fetchHostActivity(hostId, rangeStart, rangeEnd), getAppSettings()]);

  const totals = {
    onlineSeconds: 0,
    earnings: { totalPaise: 0, callsPaise: 0, giftsPaise: 0, livePaise: 0, otherPaise: 0 },
    calls: { received: 0, answered: 0, missed: 0, rejected: 0, talkSeconds: 0 },
  };
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const { start, end } = dayRangeInTimeZone(date, tz);
    const day = summarizeDay(hostId, activity, date, start, end, now);
    totals.onlineSeconds += day.online.totalSeconds;
    totals.earnings.totalPaise += day.earnings.totalPaise;
    totals.earnings.callsPaise += day.earnings.videoCalls.amountPaise + day.earnings.voiceCalls.amountPaise;
    totals.earnings.giftsPaise += day.earnings.gifts.amountPaise;
    totals.earnings.livePaise += day.earnings.liveStreams.amountPaise;
    totals.earnings.otherPaise += day.earnings.other.amountPaise;
    totals.calls.received += day.calls.received;
    totals.calls.answered += day.calls.answered;
    totals.calls.missed += day.calls.missed;
    totals.calls.rejected += day.calls.rejected;
    totals.calls.talkSeconds += day.calls.talkSeconds;
  }

  // Quality bands of the finished calls that came in during the range.
  const quality = { bad: 0, good: 0, excellent: 0 };
  for (const c of activity.receivedCalls) {
    const band = callDurationQuality(c, settings.callQuality);
    if (band) quality[band] += 1;
  }

  const { talkSeconds, ...calls } = totals.calls;
  return {
    from,
    to,
    onlineSeconds: totals.onlineSeconds,
    earnings: totals.earnings,
    calls: { ...calls, avgCallSeconds: calls.answered > 0 ? Math.round(talkSeconds / calls.answered) : 0 },
    quality,
  };
}

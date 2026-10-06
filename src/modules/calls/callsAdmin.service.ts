import { and, count, desc, eq, gte, ilike, inArray, lt, or, SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { calls, users } from "../../db/schema";
import { dayRangeInTimeZone } from "../../lib/dayBounds";
import { AppError } from "../../lib/errors";
import { AppSettings, getAppSettings } from "../settings/appSettings.service";
import { getCurrentPaisePerBean } from "../wallet/wallet.service";
import { callDurationQuality, CallListFilter } from "./calls.service";

// Admin Calls screens: what's happening right now, and the full history.

const caller = alias(users, "caller");
const callHost = alias(users, "call_host");

const callColumns = {
  call: calls,
  userName: caller.name,
  hostName: callHost.name,
};

type CallRowWithNames = { call: typeof calls.$inferSelect; userName: string | null; hostName: string | null };

function adminCallView(row: CallRowWithNames, paisePerBean: number, bands: AppSettings["callQuality"]) {
  const c = row.call;
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    endReason: c.endReason,
    userId: c.userId,
    userName: row.userName ?? "Unknown",
    hostId: c.hostId,
    hostName: row.hostName ?? "Unknown",
    mediaProvider: c.mediaProvider,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    durationSeconds: c.startedAt && c.endedAt ? Math.floor((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : 0,
    ratePerMinutePaiseSnapshot: c.ratePerMinutePaiseSnapshot,
    totalAmountPaise: c.totalAmountPaise,
    // The host's share at the current rate — the same basis as the host's own Calls screen.
    earnedPaise: c.totalBeans * paisePerBean,
    durationQuality: callDurationQuality(c, bands),
    createdAt: c.createdAt,
  };
}

function withNames() {
  return db
    .select(callColumns)
    .from(calls)
    .innerJoin(caller, eq(caller.id, calls.userId))
    .innerJoin(callHost, eq(callHost.id, calls.hostId));
}

export async function listLiveCallsForAdmin() {
  const [rows, paisePerBean, settings] = await Promise.all([
    withNames().where(inArray(calls.status, ["ringing", "ongoing"])).orderBy(desc(calls.createdAt)),
    getCurrentPaisePerBean(),
    getAppSettings(),
  ]);
  return { calls: rows.map((r) => adminCallView(r, paisePerBean, settings.callQuality)) };
}

export type AdminCallListQuery = {
  filter: CallListFilter;
  userId?: string;
  hostId?: string;
  q?: string;
  from?: string;
  to?: string;
  tz: string;
  page: number;
  pageSize: number;
};

export async function listCallsForAdmin(query: AdminCallListQuery) {
  const conditions: SQL[] = [];
  if (query.filter === "video" || query.filter === "voice") conditions.push(eq(calls.type, query.filter));
  if (query.filter === "missed") conditions.push(eq(calls.status, "missed"));
  if (query.userId) conditions.push(eq(calls.userId, query.userId));
  if (query.hostId) conditions.push(eq(calls.hostId, query.hostId));
  if (query.from) conditions.push(gte(calls.createdAt, dayRangeInTimeZone(query.from, query.tz).start));
  if (query.to) conditions.push(lt(calls.createdAt, dayRangeInTimeZone(query.to, query.tz).end));
  if (query.q) {
    const nameMatch = or(ilike(caller.name, `%${query.q}%`), ilike(callHost.name, `%${query.q}%`))!;
    const isId = /^[0-9a-f-]{36}$/i.test(query.q);
    conditions.push(isId ? or(eq(calls.id, query.q), nameMatch)! : nameMatch);
  }
  const where = and(...conditions);

  const [rows, [{ total }], paisePerBean, settings] = await Promise.all([
    withNames()
      .where(where)
      .orderBy(desc(calls.createdAt), desc(calls.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(calls)
      .innerJoin(caller, eq(caller.id, calls.userId))
      .innerJoin(callHost, eq(callHost.id, calls.hostId))
      .where(where),
    getCurrentPaisePerBean(),
    getAppSettings(),
  ]);

  return {
    calls: rows.map((r) => adminCallView(r, paisePerBean, settings.callQuality)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.page * query.pageSize < total,
  };
}

export async function getCallForAdmin(callId: string) {
  const [[row], paisePerBean, settings] = await Promise.all([
    withNames().where(eq(calls.id, callId)).limit(1),
    getCurrentPaisePerBean(),
    getAppSettings(),
  ]);
  if (!row) throw new AppError(404, "Call not found");
  return adminCallView(row, paisePerBean, settings.callQuality);
}

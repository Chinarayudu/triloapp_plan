import { and, count, desc, eq, gte, isNull, lt, or, SQL, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { captureEvents, captureEventTypeEnum, users } from "../../db/schema";
import { dayRangeInTimeZone } from "../../lib/dayBounds";

// Admin Security Events screen — the screenshot/recording protection events
// both apps report (POST /moderation/capture-event).

type EventType = (typeof captureEventTypeEnum.enumValues)[number];

// Events from before types existed were always screenshot attempts.
const LEGACY_TYPE: EventType = "SCREENSHOT_ATTEMPT";
const REPEAT_OFFENDER_MIN_EVENTS = 3;

export type SecurityEventQuery = {
  role?: "user" | "host";
  type?: EventType;
  accountId?: string;
  from?: string;
  to?: string;
  tz: string;
  page: number;
  pageSize: number;
};

export async function listSecurityEvents(query: SecurityEventQuery) {
  const conditions: SQL[] = [];
  if (query.role) conditions.push(eq(users.role, query.role));
  if (query.type) {
    conditions.push(
      query.type === LEGACY_TYPE ? or(eq(captureEvents.type, LEGACY_TYPE), isNull(captureEvents.type))! : eq(captureEvents.type, query.type),
    );
  }
  if (query.accountId) conditions.push(eq(captureEvents.userId, query.accountId));
  if (query.from) conditions.push(gte(captureEvents.createdAt, dayRangeInTimeZone(query.from, query.tz).start));
  if (query.to) conditions.push(lt(captureEvents.createdAt, dayRangeInTimeZone(query.to, query.tz).end));
  const where = and(...conditions);

  const [rows, [{ total }], offenders] = await Promise.all([
    db
      .select({ event: captureEvents, accountName: users.name, role: users.role })
      .from(captureEvents)
      .innerJoin(users, eq(users.id, captureEvents.userId))
      .where(where)
      .orderBy(desc(captureEvents.createdAt), desc(captureEvents.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(captureEvents).innerJoin(users, eq(users.id, captureEvents.userId)).where(where),
    // Accounts with 3+ events within the same filters, most events first.
    db
      .select({ accountId: captureEvents.userId, accountName: users.name, role: users.role, count: sql<number>`count(*)::int` })
      .from(captureEvents)
      .innerJoin(users, eq(users.id, captureEvents.userId))
      .where(where)
      .groupBy(captureEvents.userId, users.name, users.role)
      .having(sql`count(*) >= ${REPEAT_OFFENDER_MIN_EVENTS}`)
      .orderBy(sql`count(*) desc`),
  ]);

  return {
    events: rows.map(({ event, accountName, role }) => ({
      id: event.id,
      type: event.type ?? LEGACY_TYPE,
      accountId: event.userId,
      accountName: accountName ?? "Unknown",
      role,
      context: event.context,
      contextId: event.contextId,
      createdAt: event.createdAt,
    })),
    repeatOffenders: offenders.map((o) => ({ ...o, accountName: o.accountName ?? "Unknown" })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.page * query.pageSize < total,
  };
}

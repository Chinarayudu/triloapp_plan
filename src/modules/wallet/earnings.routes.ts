import { Router } from "express";
import { z } from "zod";
import { addDays, dateInTimeZone, DEFAULT_TIME_ZONE, isValidDateString, isValidTimeZone, startOfDayInTimeZone } from "../../lib/dayBounds";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getHostDailyStats, getHostDailySummary } from "./dailyStats.service";
import {
  getHostDashboard,
  getHostEarningsBreakdown,
  getHostEarningsStatementCsv,
  getHostEarningsSummary,
  getHostHistory,
} from "./earnings.service";

export const earningsRouter = Router();

earningsRouter.get("/me/dashboard", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json(await getHostDashboard(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

earningsRouter.get("/me/earnings", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json(await getHostEarningsSummary(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

// from/to accept either a full ISO datetime (exact instant; to is exclusive,
// the original contract) or a plain YYYY-MM-DD date, read as an IST calendar
// day with to *inclusive* — so from=to=2026-09-27 means that whole day.
const rangeBoundSchema = z.union([z.string().datetime(), z.string().refine(isValidDateString, "Invalid date")]).optional();
const rangeQuerySchema = z.object({ from: rangeBoundSchema, to: rangeBoundSchema });

function resolveRange(query: z.infer<typeof rangeQuerySchema>): { from: Date; to: Date } {
  const now = new Date();
  const defaultFrom = startOfDayInTimeZone(dateInTimeZone(now, DEFAULT_TIME_ZONE).slice(0, 8) + "01", DEFAULT_TIME_ZONE);

  let from = defaultFrom;
  if (query.from) {
    from = isValidDateString(query.from) ? startOfDayInTimeZone(query.from, DEFAULT_TIME_ZONE) : new Date(query.from);
  }
  let to = now;
  if (query.to) {
    to = isValidDateString(query.to) ? startOfDayInTimeZone(addDays(query.to, 1), DEFAULT_TIME_ZONE) : new Date(query.to);
  }
  if (from >= to) throw new AppError(400, "from must be before to");
  return { from, to };
}

earningsRouter.get("/me/earnings/breakdown", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = rangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { from, to } = resolveRange(parsed.data);
    res.json(await getHostEarningsBreakdown(req.user!.sub, from, to));
  } catch (err) {
    next(err);
  }
});

// v1 export — CSV only (a same-day job vs. PDF's rendering step); reuses
// the exact same default-period logic as /me/earnings/breakdown above.
earningsRouter.get("/me/earnings/statement", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = rangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { from, to } = resolveRange(parsed.data);
    const csv = await getHostEarningsStatementCsv(req.user!.sub, from, to);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="statement-${dateInTimeZone(from, DEFAULT_TIME_ZONE)}-to-${dateInTimeZone(new Date(to.getTime() - 1), DEFAULT_TIME_ZONE)}.csv"`,
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

const historyQuerySchema = z.object({
  type: z.enum(["all", "calls", "gifts", "live"]).default("all"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

earningsRouter.get("/me/history", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { type, page, pageSize } = parsed.data;
    res.json(await getHostHistory(req.user!.sub, type, page, pageSize));
  } catch (err) {
    next(err);
  }
});

// Host app daily report (online time + earnings per day). Dates are
// calendar days in tz (default IST); a future date is a client bug, not "zero".
const dateSchema = z.string().refine(isValidDateString, "Invalid date, expected YYYY-MM-DD");
const tzSchema = z.string().refine(isValidTimeZone, "Invalid time zone").default(DEFAULT_TIME_ZONE);
const MAX_SUMMARY_DAYS = 31;

function assertNotFuture(date: string, tz: string): void {
  if (date > dateInTimeZone(new Date(), tz)) throw new AppError(400, "Date cannot be in the future");
}

const dailyStatsQuerySchema = z.object({ date: dateSchema, tz: tzSchema });

earningsRouter.get("/me/stats/daily", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = dailyStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { date, tz } = parsed.data;
    assertNotFuture(date, tz);
    res.json(await getHostDailyStats(req.user!.sub, date, tz));
  } catch (err) {
    next(err);
  }
});

const dailySummaryQuerySchema = z.object({ from: dateSchema, to: dateSchema, tz: tzSchema });

earningsRouter.get("/me/stats/daily-summary", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = dailySummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { from, to, tz } = parsed.data;
    if (from > to) throw new AppError(400, "from must not be after to");
    assertNotFuture(to, tz);
    if (addDays(from, MAX_SUMMARY_DAYS - 1) < to) throw new AppError(400, `At most ${MAX_SUMMARY_DAYS} days per request`);
    res.json(await getHostDailySummary(req.user!.sub, from, to, tz));
  } catch (err) {
    next(err);
  }
});

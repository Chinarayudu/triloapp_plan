import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getHostDashboard, getHostEarningsBreakdown, getHostEarningsSummary, getHostHistory } from "./earnings.service";

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

const breakdownQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

earningsRouter.get("/me/earnings/breakdown", requireAuth, requireRole("host"), async (req, res, next) => {
  const parsed = breakdownQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom;
    const to = parsed.data.to ? new Date(parsed.data.to) : now;
    res.json(await getHostEarningsBreakdown(req.user!.sub, from, to));
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

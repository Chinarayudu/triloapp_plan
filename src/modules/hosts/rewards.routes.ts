import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireAdminPermission } from "../admin/permissions";
import {
  getHostRewards,
  getRewardConfig,
  getRewardStandingsForAdmin,
  listHostRewardPayouts,
  listRewardSettlementsForAdmin,
  setRewardConfig,
} from "./rewards.service";

// Host daily/weekly rewards (rewards.service.ts). hostRewardsRouter is mounted
// under /user and /host like the other per-app routers; the admin router once
// at the root.

export const hostRewardsRouter = Router();
export const hostRewardsAdminRouter = Router();

const paging = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
const periodSchema = z.enum(["daily", "weekly"]);

hostRewardsRouter.get("/me/rewards", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json(await getHostRewards(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

hostRewardsRouter.get("/me/rewards/history", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const parsed = paging.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "page and pageSize must be positive integers (pageSize up to 100)");
    res.json(await listHostRewardPayouts(req.user!.sub, parsed.data.page, parsed.data.pageSize));
  } catch (err) {
    next(err);
  }
});

const adminFinance = [requireAuth, requireAdminPermission("finance")];

hostRewardsAdminRouter.get("/admin/host-rewards", ...adminFinance, async (_req, res, next) => {
  try {
    res.json({ daily: await getRewardConfig("daily"), weekly: await getRewardConfig("weekly") });
  } catch (err) {
    next(err);
  }
});

const rewardConfigSchema = z.object({
  enabled: z.boolean(),
  minQualifyingBeans: z.number().int().min(0),
  // Ranks 1..n in order, no gaps — checked below.
  tiers: z.array(z.object({ rank: z.number().int().positive(), rewardBeans: z.number().int().positive().max(100_000_000) })).max(100),
  reason: z.string().trim().max(500).optional(),
});

hostRewardsAdminRouter.post("/admin/host-rewards/:period", ...adminFinance, async (req, res, next) => {
  try {
    const period = periodSchema.safeParse(req.params.period);
    if (!period.success) throw new AppError(404, "Period must be daily or weekly");
    const parsed = rewardConfigSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    const { reason, ...config } = parsed.data;
    config.tiers.forEach((tier, i) => {
      if (tier.rank !== i + 1) throw new AppError(422, "tiers must be ranks 1, 2, 3, … in order with no gaps");
    });
    if (config.enabled && config.tiers.length === 0) throw new AppError(422, "Add at least one rank to turn rewards on");
    res.status(201).json(await setRewardConfig(req.user!.sub, period.data, config, reason));
  } catch (err) {
    next(err);
  }
});

hostRewardsAdminRouter.get("/admin/host-rewards/:period/standings", ...adminFinance, async (req, res, next) => {
  try {
    const period = periodSchema.safeParse(req.params.period);
    if (!period.success) throw new AppError(404, "Period must be daily or weekly");
    res.json(await getRewardStandingsForAdmin(period.data));
  } catch (err) {
    next(err);
  }
});

hostRewardsAdminRouter.get("/admin/host-rewards/:period/settlements", ...adminFinance, async (req, res, next) => {
  try {
    const period = periodSchema.safeParse(req.params.period);
    if (!period.success) throw new AppError(404, "Period must be daily or weekly");
    const parsed = paging.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "page and pageSize must be positive integers (pageSize up to 100)");
    res.json(await listRewardSettlementsForAdmin(period.data, parsed.data.page, parsed.data.pageSize));
  } catch (err) {
    next(err);
  }
});

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { cancelVipSubscription, listActiveVipPlans, listMySubscriptions, subscribeToVip } from "./vip.service";

export const vipRouter = Router();

vipRouter.get("/vip/plans", requireAuth, async (_req, res, next) => {
  try {
    res.json({ plans: await listActiveVipPlans() });
  } catch (err) {
    next(err);
  }
});

const subscribeSchema = z.object({ planId: z.string().uuid() });

vipRouter.post("/vip/subscribe", requireAuth, requireRole("user"), validateBody(subscribeSchema), async (req, res, next) => {
  try {
    const { planId } = req.body as z.infer<typeof subscribeSchema>;
    res.status(201).json(await subscribeToVip(req.user!.sub, planId));
  } catch (err) {
    next(err);
  }
});

vipRouter.get("/me/subscriptions", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    res.json({ subscriptions: await listMySubscriptions(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});

vipRouter.post("/me/subscriptions/:id/cancel", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid subscription id");
    res.json(await cancelVipSubscription(req.user!.sub, id.data));
  } catch (err) {
    next(err);
  }
});

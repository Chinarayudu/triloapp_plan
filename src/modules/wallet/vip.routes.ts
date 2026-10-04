import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import {
  cancelVipSubscription,
  devResolveVipPurchase,
  getVipPurchaseById,
  initiateVipPurchase,
  listActiveVipPlans,
  listMySubscriptions,
  syncVipPurchaseWithGateway,
} from "./vip.service";

export const vipRouter = Router();

vipRouter.get("/vip/plans", requireAuth, async (_req, res, next) => {
  try {
    res.json({ plans: await listActiveVipPlans() });
  } catch (err) {
    next(err);
  }
});

const subscribeSchema = z.object({ planId: z.string().uuid() });

// Starts a paid purchase — returns { id, status: "created", paymentSessionId,
// checkoutMode, ... } for Cashfree's checkout. VIP activates only once the
// payment is confirmed (webhook, or GET /vip/purchases/:id after checkout).
vipRouter.post("/vip/subscribe", requireAuth, requireRole("user"), validateBody(subscribeSchema), async (req, res, next) => {
  try {
    const { planId } = req.body as z.infer<typeof subscribeSchema>;
    res.status(201).json(await initiateVipPurchase(req.user!.sub, planId));
  } catch (err) {
    next(err);
  }
});

function parsePurchaseId(raw: unknown): string {
  const id = z.string().uuid().safeParse(raw);
  if (!id.success) throw new AppError(400, "Invalid purchase id");
  return id.data;
}

vipRouter.get("/vip/purchases/:id", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const purchase = await getVipPurchaseById(parsePurchaseId(req.params.id));
    if (!purchase) throw new AppError(404, "VIP purchase not found");
    if (purchase.userId !== req.user!.sub) throw new AppError(403, "Not your purchase");
    res.json(await syncVipPurchaseWithGateway(purchase));
  } catch (err) {
    next(err);
  }
});

const devResolveSchema = z.object({ outcome: z.enum(["success", "failed"]) });

// Fakes the payment outcome without Cashfree — non-prod only.
vipRouter.post(
  "/vip/purchases/:id/dev-resolve",
  requireAuth,
  requireRole("user"),
  validateBody(devResolveSchema),
  async (req, res, next) => {
    try {
      if (env.NODE_ENV === "production") throw new AppError(403, "Disabled in production");
      const id = parsePurchaseId(req.params.id);
      const purchase = await getVipPurchaseById(id);
      if (!purchase) throw new AppError(404, "VIP purchase not found");
      if (purchase.userId !== req.user!.sub) throw new AppError(403, "Not your purchase");
      const { outcome } = req.body as z.infer<typeof devResolveSchema>;
      res.json(await devResolveVipPurchase(id, outcome));
    } catch (err) {
      next(err);
    }
  },
);

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

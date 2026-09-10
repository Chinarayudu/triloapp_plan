import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { devResolveRecharge, getRechargeTxnById, initiateRecharge, listRechargePackages } from "./recharge.service";
import { creditUserWallet, getHostBeanBalance, getUserWalletBalance, paiseToDisplayBeans } from "./wallet.service";

export const walletRouter = Router();

walletRouter.get("/wallet", requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role === "host") {
      const beanBalance = await getHostBeanBalance(req.user!.sub);
      res.json({ beanBalance });
      return;
    }
    const balancePaise = await getUserWalletBalance(req.user!.sub);
    res.json({ balancePaise, displayBeans: paiseToDisplayBeans(balancePaise) });
  } catch (err) {
    next(err);
  }
});

// Talktime/Add-balance screens' preset tiles (User app design follow-up).
walletRouter.get("/wallet/recharge-packages", requireAuth, async (_req, res, next) => {
  try {
    res.json({ packages: await listRechargePackages() });
  } catch (err) {
    next(err);
  }
});

const initiateRechargeSchema = z.object({ packageId: z.string().uuid() });

// Order-creation step (BACKEND_PLAN.md §2 step 1) — "Processing payment"
// screen. The actual gateway call is dev-stubbed below (no real gateway
// wired up yet, §3), same pattern as withdrawal.service.ts's payout stub.
walletRouter.post(
  "/wallet/recharge/initiate",
  requireAuth,
  requireRole("user"),
  validateBody(initiateRechargeSchema),
  async (req, res, next) => {
    try {
      const { packageId } = req.body as z.infer<typeof initiateRechargeSchema>;
      const txn = await initiateRecharge(req.user!.sub, packageId);
      res.status(201).json(txn);
    } catch (err) {
      next(err);
    }
  },
);

walletRouter.get("/wallet/recharge/:id", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid recharge id");
    const txn = await getRechargeTxnById(id.data);
    if (!txn) throw new AppError(404, "Recharge transaction not found");
    if (txn.userId !== req.user!.sub) throw new AppError(403, "Not your recharge");
    res.json(txn);
  } catch (err) {
    next(err);
  }
});

const devResolveRechargeSchema = z.object({ outcome: z.enum(["success", "failed"]) });

// Stands in for the payment gateway's webhook — non-prod only, same
// hard-block convention as every other dev escape hatch in this codebase.
walletRouter.post(
  "/wallet/recharge/:id/dev-resolve",
  requireAuth,
  requireRole("user"),
  validateBody(devResolveRechargeSchema),
  async (req, res, next) => {
    try {
      if (env.NODE_ENV === "production") throw new AppError(403, "Disabled in production");
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) throw new AppError(400, "Invalid recharge id");

      const existing = await getRechargeTxnById(id.data);
      if (!existing) throw new AppError(404, "Recharge transaction not found");
      if (existing.userId !== req.user!.sub) throw new AppError(403, "Not your recharge");

      const { outcome } = req.body as z.infer<typeof devResolveRechargeSchema>;
      res.json(await devResolveRecharge(id.data, outcome));
    } catch (err) {
      next(err);
    }
  },
);

const devCreditSchema = z.object({ amountPaise: z.number().int().positive().max(10_000_00) });

// No payment gateway is wired up yet (BACKEND_PLAN.md §2/§3 — pending a
// business decision on the gateway). This is the escape hatch that lets
// the rest of the system (call billing, gifting, ...) be built and tested
// for real in the meantime, the same way OTP has a dev-mode code and
// presence has an in-memory store. Hard-blocked in production so it can
// never become an accidental free-money bug.
walletRouter.post("/wallet/dev-credit", requireAuth, validateBody(devCreditSchema), async (req, res, next) => {
  try {
    if (env.NODE_ENV === "production") {
      throw new AppError(403, "Dev-credit is disabled in production");
    }
    if (req.user!.role !== "user") {
      throw new AppError(403, "Only USER wallets can be dev-credited");
    }

    const { amountPaise } = req.body as z.infer<typeof devCreditSchema>;
    const { balanceAfter } = await creditUserWallet(
      req.user!.sub,
      amountPaise,
      "dev_credit",
      null,
      `dev-credit:${randomUUID()}`,
    );
    res.json({ balancePaise: balanceAfter });
  } catch (err) {
    next(err);
  }
});

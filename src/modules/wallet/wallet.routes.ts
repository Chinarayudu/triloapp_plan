import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { creditUserWallet, getHostBeanBalance, getUserWalletBalance } from "./wallet.service";

export const walletRouter = Router();

walletRouter.get("/wallet", requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role === "host") {
      const beanBalance = await getHostBeanBalance(req.user!.sub);
      res.json({ beanBalance });
      return;
    }
    const balancePaise = await getUserWalletBalance(req.user!.sub);
    res.json({ balancePaise });
  } catch (err) {
    next(err);
  }
});

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

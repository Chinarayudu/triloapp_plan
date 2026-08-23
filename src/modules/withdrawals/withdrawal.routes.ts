import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { devAdminDecision, devResolvePayout, getWithdrawalById, listWithdrawalsForHost, requestWithdrawal } from "./withdrawal.service";

export const withdrawalsRouter = Router();

const withdrawalIdSchema = z.string().uuid();

// Express 5's param typing is `string | string[]` — same guard as
// calls.routes.ts's parseCallId / live.routes.ts's parseBroadcastId.
function parseWithdrawalId(raw: unknown): string {
  const result = withdrawalIdSchema.safeParse(raw);
  if (!result.success) throw new AppError(400, "Invalid withdrawal id");
  return result.data;
}

const requestSchema = z.object({ beans: z.number().int().positive() });

withdrawalsRouter.post(
  "/withdrawals",
  requireAuth,
  requireRole("host"),
  validateBody(requestSchema),
  async (req, res, next) => {
    try {
      const { beans } = req.body as z.infer<typeof requestSchema>;
      const request = await requestWithdrawal(req.user!.sub, beans);
      res.status(201).json(request);
    } catch (err) {
      next(err);
    }
  },
);

withdrawalsRouter.get("/withdrawals", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const requests = await listWithdrawalsForHost(req.user!.sub);
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

withdrawalsRouter.get("/withdrawals/:id", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const request = await getWithdrawalById(parseWithdrawalId(req.params.id));
    if (!request) throw new AppError(404, "Withdrawal request not found");
    if (request.hostId !== req.user!.sub) throw new AppError(403, "Not your withdrawal request");
    res.json(request);
  } catch (err) {
    next(err);
  }
});

const adminDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

// Stands in for the Phase 9 admin withdrawal-approval queue (no admin
// auth/panel exists yet to gate this behind) — same non-prod-only escape
// hatch as wallet.routes.ts's POST /wallet/dev-credit.
withdrawalsRouter.post(
  "/withdrawals/:id/dev-admin-decision",
  requireAuth,
  validateBody(adminDecisionSchema),
  async (req, res, next) => {
    try {
      if (env.NODE_ENV === "production") throw new AppError(403, "Disabled in production");
      const { decision } = req.body as z.infer<typeof adminDecisionSchema>;
      const request = await devAdminDecision(parseWithdrawalId(req.params.id), decision);
      res.json(request);
    } catch (err) {
      next(err);
    }
  },
);

const resolvePayoutSchema = z.object({ outcome: z.enum(["paid", "failed"]), reason: z.string().max(500).optional() });

// Stands in for the payout gateway's webhook (BACKEND_PLAN.md §2) — no
// real gateway is configured to call one yet (src/lib/payout.ts).
withdrawalsRouter.post(
  "/withdrawals/:id/dev-resolve-payout",
  requireAuth,
  validateBody(resolvePayoutSchema),
  async (req, res, next) => {
    try {
      if (env.NODE_ENV === "production") throw new AppError(403, "Disabled in production");
      const { outcome, reason } = req.body as z.infer<typeof resolvePayoutSchema>;
      const request = await devResolvePayout(parseWithdrawalId(req.params.id), outcome, reason);
      res.json(request);
    } catch (err) {
      next(err);
    }
  },
);

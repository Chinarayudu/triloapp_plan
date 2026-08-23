import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { logger } from "./logger";

// No payout gateway is wired up yet — the Razorpay key pair supplied for
// this project failed live verification (401 on a test order create), so
// per the same rule applied to recharge (BACKEND_PLAN.md §2), we do not
// build against unverified credentials. This mirrors src/lib/otpSender.ts's
// shape: loud failure in production (a real host waiting on real money),
// dev-mode logging everywhere else so the withdrawal request/approval/
// ledger flow around this call can still be built and tested for real.
//
// A real payout is asynchronous even at the gateway (RazorpayX payouts
// settle via NEFT/IMPS on their own timeline) — "initiated" here means
// "submitted", not "money moved". withdrawal.service.ts always parks the
// request at `processing` after this call and only a webhook (or, until
// that's wired up, the dev-only /withdrawals/:id/dev-resolve-payout
// endpoint) resolves it to paid/failed.
export async function initiatePayout(params: {
  withdrawalRequestId: string;
  hostId: string;
  amountPaise: number;
  payoutDetails: string;
}): Promise<{ payoutTxnId: string }> {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "No payout gateway configured for production — Razorpay payout credentials pending verification (BACKEND_PLAN.md §2)",
    );
  }

  const payoutTxnId = `dev-payout-${randomUUID()}`;
  logger.info({ ...params, payoutTxnId }, "Payout initiated (dev mode — real payout gateway not configured)");
  return { payoutTxnId };
}

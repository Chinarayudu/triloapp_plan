import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, users, withdrawalPolicyConfigs, withdrawalRequests, withdrawalSlabs } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { initiatePayout } from "../../lib/payout";
import { creditHostBeans, debitHostBeans } from "../wallet/wallet.service";

type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;

export async function getActiveWithdrawalPolicy() {
  const [row] = await db
    .select()
    .from(withdrawalPolicyConfigs)
    .where(lte(withdrawalPolicyConfigs.effectiveFrom, new Date()))
    .orderBy(desc(withdrawalPolicyConfigs.effectiveFrom))
    .limit(1);
  if (!row) throw new Error("No withdrawal policy config seeded — run `npm run db:seed`");
  return row;
}

// Multiple slab rows can be active (added) at different times for
// different, possibly overlapping-in-time bean ranges — the applicable
// one is whichever active row's [minBeans, maxBeans] actually contains
// the requested amount, most-recently-added first.
export async function getActiveSlabForBeans(beans: number) {
  const rows = await db
    .select()
    .from(withdrawalSlabs)
    .where(lte(withdrawalSlabs.effectiveFrom, new Date()))
    .orderBy(desc(withdrawalSlabs.effectiveFrom));
  const match = rows.find((row) => beans >= row.minBeans && (row.maxBeans === null || beans <= row.maxBeans));
  if (!match) throw new Error(`No withdrawal slab covers ${beans} beans — run \`npm run db:seed\` or check slab ranges`);
  return match;
}

export async function listWithdrawalsForHost(hostId: string): Promise<WithdrawalRequest[]> {
  return db.select().from(withdrawalRequests).where(eq(withdrawalRequests.hostId, hostId)).orderBy(desc(withdrawalRequests.createdAt));
}

export async function getWithdrawalById(id: string): Promise<WithdrawalRequest | undefined> {
  const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, id)).limit(1);
  return row;
}

export async function requestWithdrawal(hostId: string, beans: number): Promise<WithdrawalRequest> {
  if (beans <= 0) throw new AppError(400, "beans must be positive");

  const [host] = await db.select().from(users).where(eq(users.id, hostId)).limit(1);
  if (!host) throw new AppError(404, "Host not found");
  if (host.kycStatus !== "approved") throw new AppError(403, "KYC must be approved before requesting a withdrawal");

  const [hostProfile] = await db.select().from(hostProfiles).where(eq(hostProfiles.userId, hostId)).limit(1);
  if (!hostProfile?.payoutDetails) throw new AppError(403, "Add payout details before requesting a withdrawal");

  const policy = await getActiveWithdrawalPolicy();
  const slab = await getActiveSlabForBeans(beans);
  const convertedAmountPaise = beans * slab.paisePerBean;

  if (convertedAmountPaise < policy.minAmountPaise) {
    throw new AppError(400, `Minimum withdrawal amount is ${policy.minAmountPaise} paise`);
  }

  const windowStart = new Date(Date.now() - policy.windowDays * 24 * 60 * 60 * 1000);
  const recentRequests = await db
    .select()
    .from(withdrawalRequests)
    .where(and(eq(withdrawalRequests.hostId, hostId), gte(withdrawalRequests.createdAt, windowStart)));
  if (recentRequests.length >= policy.maxRequestsPerWindow) {
    throw new AppError(429, `Withdrawal frequency limit reached (${policy.maxRequestsPerWindow} per ${policy.windowDays} days)`);
  }

  const autoApprove = convertedAmountPaise <= policy.autoApproveThresholdPaise;

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(withdrawalRequests)
      .values({
        hostId,
        beans,
        paisePerBeanSnapshot: slab.paisePerBean,
        convertedAmountPaise,
        status: autoApprove ? "approved" : "pending",
        payoutDetailsSnapshot: hostProfile.payoutDetails as string,
      })
      .returning();

    await debitHostBeans(tx, hostId, beans, "withdrawal", row.id, `withdrawal:${row.id}:debit`);

    return row;
  });

  if (!autoApprove) return created;
  return initiatePayoutForRequest(created);
}

// Shared by the auto-approve path above and the dev-admin-decision
// "approve" path below — both converge on the same gateway call once a
// request reaches `approved`, so the transition to `processing` can't
// drift between the two.
async function initiatePayoutForRequest(request: WithdrawalRequest): Promise<WithdrawalRequest> {
  const { payoutTxnId } = await initiatePayout({
    withdrawalRequestId: request.id,
    hostId: request.hostId,
    amountPaise: request.convertedAmountPaise,
    payoutDetails: request.payoutDetailsSnapshot,
  });

  const [updated] = await db
    .update(withdrawalRequests)
    .set({ status: "processing", payoutTxnId, updatedAt: new Date() })
    .where(eq(withdrawalRequests.id, request.id))
    .returning();
  return updated;
}

// Stands in for the Phase 9 admin withdrawal-approval queue (BR-EARN-05,
// BR-ADM-05) — there is no admin auth/panel yet to gate this behind, so
// it's a dev-only escape hatch like wallet.routes.ts's POST /wallet/
// dev-credit, hard-blocked in production by the route handler.
export async function devAdminDecision(id: string, decision: "approve" | "reject"): Promise<WithdrawalRequest> {
  const request = await getWithdrawalById(id);
  if (!request) throw new AppError(404, "Withdrawal request not found");
  if (request.status !== "pending") throw new AppError(409, `Request is ${request.status}, not pending`);

  if (decision === "reject") {
    return db.transaction(async (tx) => {
      await creditHostBeans(tx, request.hostId, request.beans, "withdrawal", request.id, `withdrawal:${request.id}:reject-reversal`);
      const [updated] = await tx
        .update(withdrawalRequests)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(withdrawalRequests.id, id))
        .returning();
      return updated;
    });
  }

  const [approved] = await db
    .update(withdrawalRequests)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(withdrawalRequests.id, id))
    .returning();
  return initiatePayoutForRequest(approved);
}

// Stands in for the payout gateway's webhook (BACKEND_PLAN.md §2) — same
// dev-only reasoning as devAdminDecision, since there is no real gateway
// configured yet to call a real webhook back.
export async function devResolvePayout(
  id: string,
  outcome: "paid" | "failed",
  reason?: string,
): Promise<WithdrawalRequest> {
  const request = await getWithdrawalById(id);
  if (!request) throw new AppError(404, "Withdrawal request not found");
  if (request.status !== "processing") throw new AppError(409, `Request is ${request.status}, not processing`);

  if (outcome === "failed") {
    return db.transaction(async (tx) => {
      await creditHostBeans(tx, request.hostId, request.beans, "withdrawal", request.id, `withdrawal:${request.id}:failure-reversal`);
      const [updated] = await tx
        .update(withdrawalRequests)
        .set({ status: "failed", failureReason: reason ?? "Payout failed", updatedAt: new Date() })
        .where(eq(withdrawalRequests.id, id))
        .returning();
      return updated;
    });
  }

  const [updated] = await db
    .update(withdrawalRequests)
    .set({ status: "paid", updatedAt: new Date() })
    .where(eq(withdrawalRequests.id, id))
    .returning();
  return updated;
}

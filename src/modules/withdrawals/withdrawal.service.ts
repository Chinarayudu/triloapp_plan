import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { moderationReports, users, withdrawalPolicyConfigs, withdrawalRequests, withdrawalSlabs } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { initiatePayout } from "../../lib/payout";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";
import { getPrimaryPayoutMethod } from "../hosts/payoutMethods.service";
import { createNotification } from "../notifications/notifications.service";
import { creditHostBeans, debitHostBeans } from "../wallet/wallet.service";

type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;

// BR-NOTIF-01 "withdrawal status change" — a status change reachable
// after the host's own create-request response already told them the
// immediate outcome (pending vs. auto-approved), so this covers what
// happens *after* that: an admin decision, or the payout gateway
// resolving. Real-time first, push only as the offline fallback, same
// pattern as every other notification trigger in this codebase.
async function notifyWithdrawalStatus(request: WithdrawalRequest): Promise<void> {
  emitToUser(request.hostId, "withdrawal:status", { withdrawalId: request.id, status: request.status });
  if (!(await isUserConnected(request.hostId))) {
    void sendPushNotification(request.hostId, "Withdrawal update", `Your withdrawal is now ${request.status}`);
  }
  await createNotification(
    request.hostId,
    "withdrawal_status",
    "Withdrawal update",
    `Your withdrawal is now ${request.status}`,
  );
}

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

// Admin queue (admin.routes.ts, BR-ADM-05) — status omitted lists everything,
// newest first; "pending" is the actual approval queue.
export async function listWithdrawalsByStatus(status?: WithdrawalRequest["status"]): Promise<WithdrawalRequest[]> {
  if (status) {
    return db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.status, status))
      .orderBy(desc(withdrawalRequests.createdAt));
  }
  return db.select().from(withdrawalRequests).orderBy(desc(withdrawalRequests.createdAt));
}

export async function getWithdrawalById(id: string): Promise<WithdrawalRequest | undefined> {
  const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, id)).limit(1);
  return row;
}

// The admin review screen's checklist (admin design follow-up) — these are
// exactly the same gates requestWithdrawal already enforced at request
// time, recomputed here for the admin's benefit since a host's KYC/reports
// could plausibly have changed in the time a request sat in the queue.
export async function getWithdrawalDetailForAdmin(id: string) {
  const request = await getWithdrawalById(id);
  if (!request) throw new AppError(404, "Withdrawal request not found");

  const [host] = await db.select().from(users).where(eq(users.id, request.hostId)).limit(1);
  const primaryPayoutMethod = await getPrimaryPayoutMethod(request.hostId);
  const policy = await getActiveWithdrawalPolicy();

  const [{ value: openReportCount }] = await db
    .select({ value: count() })
    .from(moderationReports)
    .where(
      and(
        eq(moderationReports.targetId, request.hostId),
        eq(moderationReports.targetType, "host"),
        eq(moderationReports.status, "pending"),
      ),
    );

  return {
    ...request,
    host: host ? { id: host.id, phone: host.phone, email: host.email, name: host.name } : null,
    verification: {
      kycApproved: host?.kycStatus === "approved",
      payoutDetailsOnFile: Boolean(primaryPayoutMethod),
      aboveMinimumAmount: request.convertedAmountPaise >= policy.minAmountPaise,
      noOpenModerationReports: openReportCount === 0,
    },
  };
}

export async function requestWithdrawal(hostId: string, beans: number): Promise<WithdrawalRequest> {
  if (beans <= 0) throw new AppError(400, "beans must be positive");

  const [host] = await db.select().from(users).where(eq(users.id, hostId)).limit(1);
  if (!host) throw new AppError(404, "Host not found");
  if (host.kycStatus !== "approved") throw new AppError(403, "KYC must be approved before requesting a withdrawal");

  const primaryPayoutMethod = await getPrimaryPayoutMethod(hostId);
  if (!primaryPayoutMethod) throw new AppError(403, "Add payout details before requesting a withdrawal");

  const policy = await getActiveWithdrawalPolicy();
  const slab = await getActiveSlabForBeans(beans);
  const convertedAmountPaise = beans * slab.paisePerBean;

  if (convertedAmountPaise < policy.minAmountPaise) {
    throw new AppError(400, `Minimum withdrawal amount is ${policy.minAmountPaise} paise`);
  }

  // Confirm-withdrawal screen's fee breakdown (Host app design follow-up):
  // a flat processing fee plus TDS, both deducted from the payout only —
  // never from the beans debited below, which always cover the full
  // requested amount regardless of what the host actually receives net.
  const processingFeePaise = policy.processingFeePaise;
  const tdsPaise = Math.floor((convertedAmountPaise * policy.tdsBasisPoints) / 10_000);
  const netPayoutPaise = convertedAmountPaise - processingFeePaise - tdsPaise;
  if (netPayoutPaise <= 0) {
    throw new AppError(400, "Withdrawal amount is too small to cover fees");
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
        processingFeePaise,
        tdsPaise,
        netPayoutPaise,
        status: autoApprove ? "approved" : "pending",
        payoutDetailsSnapshot: primaryPayoutMethod.detailsJson,
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
    amountPaise: request.netPayoutPaise,
    payoutDetails: request.payoutDetailsSnapshot,
  });

  const [updated] = await db
    .update(withdrawalRequests)
    .set({ status: "processing", payoutTxnId, updatedAt: new Date() })
    .where(eq(withdrawalRequests.id, request.id))
    .returning();
  await notifyWithdrawalStatus(updated);
  return updated;
}

// The admin withdrawal-approval queue decision (BR-EARN-05, BR-ADM-05) —
// called from admin.routes.ts, which also writes the audit log entry
// (BR-ADM-04) after this resolves; that logging lives at the route layer
// rather than here so this function stays a plain state-transition
// primitive, same as initiatePayoutForRequest below.
export async function decideWithdrawal(id: string, decision: "approve" | "reject"): Promise<WithdrawalRequest> {
  const request = await getWithdrawalById(id);
  if (!request) throw new AppError(404, "Withdrawal request not found");
  if (request.status !== "pending") throw new AppError(409, `Request is ${request.status}, not pending`);

  if (decision === "reject") {
    const rejected = await db.transaction(async (tx) => {
      await creditHostBeans(tx, request.hostId, request.beans, "withdrawal", request.id, `withdrawal:${request.id}:reject-reversal`);
      const [updated] = await tx
        .update(withdrawalRequests)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(withdrawalRequests.id, id))
        .returning();
      return updated;
    });
    await notifyWithdrawalStatus(rejected);
    return rejected;
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
    const failed = await db.transaction(async (tx) => {
      await creditHostBeans(tx, request.hostId, request.beans, "withdrawal", request.id, `withdrawal:${request.id}:failure-reversal`);
      const [updated] = await tx
        .update(withdrawalRequests)
        .set({ status: "failed", failureReason: reason ?? "Payout failed", updatedAt: new Date() })
        .where(eq(withdrawalRequests.id, id))
        .returning();
      return updated;
    });
    await notifyWithdrawalStatus(failed);
    return failed;
  }

  const [updated] = await db
    .update(withdrawalRequests)
    .set({ status: "paid", updatedAt: new Date() })
    .where(eq(withdrawalRequests.id, id))
    .returning();
  await notifyWithdrawalStatus(updated);
  return updated;
}

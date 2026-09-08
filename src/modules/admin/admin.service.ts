import { and, desc, eq, gte, inArray, isNull, lte, SQL, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  adultModeConfigs,
  auditLogs,
  beansEarnConfigs,
  calls,
  captureEvents,
  commissionConfigs,
  giftTransactions,
  gifts,
  kycSubmissions,
  moderationReports,
  users,
  withdrawalPolicyConfigs,
  withdrawalRequests,
  withdrawalSlabs,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { writeAuditLog } from "../../lib/auditLog";
import { hashPassword } from "../../lib/password";
import { disconnectUser } from "../../realtime/socket";
import { revokeAllRefreshTokensForUser } from "../auth/token.service";
import { TICK_INTERVAL_MS } from "../calls/calls.service";
import { listOnlineHostIds } from "../hosts/presence.store";
import { decideSubmission, getLatestPendingSubmission, getSubmissionDocuments } from "../users/kyc.service";
import { findUserByEmail, findUserByPhone, getUserById } from "../users/users.service";
import { AdminPermission } from "./permissions";

type User = typeof users.$inferSelect;

// ---------------------------------------------------------------------------
// KYC approval queue (BR-ADM-05)
// ---------------------------------------------------------------------------

// One row per pending submission (not per user) — a user only ever has one
// pending submission at a time (a fresh one can't be created while another
// is pending, since decideSubmission must resolve it first), but the shape
// here surfaces attemptNumber for the admin queue (BR-ACC-03/04).
export async function listPendingKyc() {
  return db
    .select({
      submissionId: kycSubmissions.id,
      userId: kycSubmissions.userId,
      attemptNumber: kycSubmissions.attemptNumber,
      submittedAt: kycSubmissions.createdAt,
      phone: users.phone,
      email: users.email,
    })
    .from(kycSubmissions)
    .innerJoin(users, eq(users.id, kycSubmissions.userId))
    .where(eq(kycSubmissions.status, "pending"))
    .orderBy(desc(kycSubmissions.createdAt));
}

export async function getKycSubmissionForReview(userId: string) {
  const submission = await getLatestPendingSubmission(userId);
  if (!submission) throw new AppError(404, "No pending KYC submission for this user");
  const documents = await getSubmissionDocuments(submission.id);
  return { ...submission, documents };
}

export async function decideKyc(
  adminId: string,
  userId: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<User> {
  const user = await getUserById(userId);
  if (!user) throw new AppError(404, "User not found");

  const submission = await getLatestPendingSubmission(userId);
  if (!submission) throw new AppError(409, `KYC is ${user.kycStatus}, not pending`);
  await decideSubmission(submission.id, decision, adminId, reason);

  // BR-ACC-04: KYC approval is the actual basis for age verification, not
  // a self-declared checkbox — a DOB submitted alongside the KYC document
  // becomes "verified" the moment a human approves the document, not before.
  const [updated] = await db
    .update(users)
    .set({
      kycStatus: decision === "approve" ? "approved" : "rejected",
      ageVerified: decision === "approve" && user.dob !== null ? true : user.ageVerified,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  await writeAuditLog(adminId, `kyc.${decision}`, "user", userId, {
    attemptNumber: submission.attemptNumber,
    ...(reason ? { reason } : {}),
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Account status — suspend/ban/reactivate (BR-ACC-05, BR-MOD-05)
// ---------------------------------------------------------------------------

export async function setAccountStatus(
  adminId: string,
  userId: string,
  status: User["status"],
  reason?: string,
): Promise<User> {
  const target = await getUserById(userId);
  if (!target) throw new AppError(404, "User not found");
  if (target.role === "admin" || target.role === "sub_admin") {
    throw new AppError(400, "Admin accounts cannot be suspended/banned through this endpoint");
  }

  const [updated] = await db
    .update(users)
    .set({ status, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (status !== "active") {
    // Blocks new logins/refreshes immediately, and drops any live socket
    // connection right now rather than waiting for the access token to
    // expire (realtime/socket.ts's disconnectUser doc comment explains the
    // one gap this doesn't close).
    await revokeAllRefreshTokensForUser(userId);
    await disconnectUser(userId);
  }

  await writeAuditLog(adminId, `account.${status}`, "user", userId, reason ? { reason } : undefined);
  return updated;
}

// ---------------------------------------------------------------------------
// Pricing/economics config (BR-ADM-02) — each of these is the same
// "insert a new row, the latest effectiveFrom wins" pattern the tables
// were already built with (wallet.service.ts, withdrawal.service.ts), so
// admin never updates a row in place — that would retroactively change
// history for anything that already snapshotted it.
// ---------------------------------------------------------------------------

// hostId omitted lists every row (global + every host's overrides);
// passed, lists just that host's own override history.
export async function listCommissionConfigs(hostId?: string) {
  if (hostId) {
    return db
      .select()
      .from(commissionConfigs)
      .where(eq(commissionConfigs.hostId, hostId))
      .orderBy(desc(commissionConfigs.effectiveFrom));
  }
  return db.select().from(commissionConfigs).orderBy(desc(commissionConfigs.effectiveFrom));
}

// hostId omitted creates a new global rate; passed, creates a
// host-specific override (BR-COM-03) — wallet.service.ts's
// getCurrentCommissionBasisPoints prefers an active override over global.
export async function createCommissionConfig(adminId: string, basisPoints: number, hostId?: string) {
  const [previousActive] = await db
    .select()
    .from(commissionConfigs)
    .where(hostId ? eq(commissionConfigs.hostId, hostId) : isNull(commissionConfigs.hostId))
    .orderBy(desc(commissionConfigs.effectiveFrom))
    .limit(1);

  const [row] = await db.insert(commissionConfigs).values({ basisPoints, hostId }).returning();
  await writeAuditLog(adminId, "config.commission.create", "commission_config", row.id, {
    previous: previousActive?.basisPoints ?? null,
    new: basisPoints,
    hostId,
  });
  return row;
}

export async function listBeansEarnConfigs() {
  return db.select().from(beansEarnConfigs).orderBy(desc(beansEarnConfigs.effectiveFrom));
}

export async function createBeansEarnConfig(adminId: string, paisePerBean: number) {
  const [previousActive] = await db.select().from(beansEarnConfigs).orderBy(desc(beansEarnConfigs.effectiveFrom)).limit(1);

  const [row] = await db.insert(beansEarnConfigs).values({ paisePerBean }).returning();
  await writeAuditLog(adminId, "config.beans_earn.create", "beans_earn_config", row.id, {
    previous: previousActive?.paisePerBean ?? null,
    new: paisePerBean,
  });
  return row;
}

export async function listWithdrawalPolicyConfigs() {
  return db.select().from(withdrawalPolicyConfigs).orderBy(desc(withdrawalPolicyConfigs.effectiveFrom));
}

export async function createWithdrawalPolicyConfig(
  adminId: string,
  policy: {
    minAmountPaise: number;
    maxRequestsPerWindow: number;
    windowDays: number;
    autoApproveThresholdPaise: number;
  },
) {
  const [previousActive] = await db.select().from(withdrawalPolicyConfigs).orderBy(desc(withdrawalPolicyConfigs.effectiveFrom)).limit(1);

  const [row] = await db.insert(withdrawalPolicyConfigs).values(policy).returning();
  await writeAuditLog(adminId, "config.withdrawal_policy.create", "withdrawal_policy_config", row.id, {
    previous: previousActive ?? null,
    new: policy,
  });
  return row;
}

export async function listWithdrawalSlabConfigs() {
  return db.select().from(withdrawalSlabs).orderBy(desc(withdrawalSlabs.effectiveFrom));
}

// Slabs are a set (each row covers one [minBeans, maxBeans) range), so
// admin replaces the whole set at once rather than adding one row — a
// single new row would leave the rest of the range covered by stale slabs.
// All rows in the new set share one effectiveFrom, so withdrawal.service.ts's
// getActiveSlabForBeans (desc-ordered, first match wins) picks the new set
// over the old one in its entirety, not a mix of both.
export async function createWithdrawalSlabSet(
  adminId: string,
  slabs: { minBeans: number; maxBeans: number | null; paisePerBean: number }[],
) {
  if (slabs.length === 0) throw new AppError(400, "At least one slab is required");
  const effectiveFrom = new Date();
  const rows = await db
    .insert(withdrawalSlabs)
    .values(slabs.map((slab) => ({ ...slab, effectiveFrom })))
    .returning();
  await writeAuditLog(adminId, "config.withdrawal_slabs.create", "withdrawal_slab", null, { slabs });
  return rows;
}

// ---------------------------------------------------------------------------
// 18+ toggle (BACKEND_PLAN.md §5, BR-MOD-01) — Phase 10. Same versioned
// "insert a new row" pattern as the pricing config above.
// ---------------------------------------------------------------------------

export async function listAdultModeConfigs() {
  return db.select().from(adultModeConfigs).orderBy(desc(adultModeConfigs.effectiveFrom));
}

// Read by live.service.ts (startBroadcast) to gate whether a host can mark
// a broadcast adult content — an unseeded platform defaults to "off" rather
// than throwing, since (unlike commission) nothing downstream requires this
// to exist for the platform to otherwise function.
export async function getCurrentAdultModeEnabled(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(adultModeConfigs)
    .where(lte(adultModeConfigs.effectiveFrom, new Date()))
    .orderBy(desc(adultModeConfigs.effectiveFrom))
    .limit(1);
  return row?.enabled ?? false;
}

export async function createAdultModeConfig(adminId: string, enabled: boolean) {
  const previousEnabled = await getCurrentAdultModeEnabled();

  const [row] = await db.insert(adultModeConfigs).values({ enabled }).returning();
  await writeAuditLog(adminId, "config.adult_mode.create", "adult_mode_config", row.id, {
    previous: previousEnabled,
    new: enabled,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Capture events (BACKEND_PLAN.md §5, BR-MOD-03) — Phase 10. Read-only
// visibility into what moderation.service.ts's logCaptureEvent recorded;
// the escalation-to-moderation-queue decision happens there, not here.
// ---------------------------------------------------------------------------

export async function listCaptureEvents(limit: number) {
  return db
    .select({
      id: captureEvents.id,
      userId: captureEvents.userId,
      userPhone: users.phone,
      context: captureEvents.context,
      contextId: captureEvents.contextId,
      createdAt: captureEvents.createdAt,
    })
    .from(captureEvents)
    .innerJoin(users, eq(users.id, captureEvents.userId))
    .orderBy(desc(captureEvents.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Gift catalog CRUD (BR-ADM-02) — previously seed-only (db/seed.ts).
// ---------------------------------------------------------------------------

export async function listAllGifts() {
  return db.select().from(gifts).orderBy(gifts.pricePaise);
}

export async function createGift(
  adminId: string,
  input: { name: string; iconUrl?: string; pricePaise: number },
) {
  const [row] = await db.insert(gifts).values(input).returning();
  await writeAuditLog(adminId, "gift.create", "gift", row.id, input);
  return row;
}

export async function updateGift(
  adminId: string,
  giftId: string,
  updates: { name?: string; iconUrl?: string; pricePaise?: number; active?: boolean },
) {
  const [existing] = await db.select().from(gifts).where(eq(gifts.id, giftId)).limit(1);
  if (!existing) throw new AppError(404, "Gift not found");

  const [row] = await db
    .update(gifts)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(gifts.id, giftId))
    .returning();
  await writeAuditLog(adminId, "gift.update", "gift", giftId, updates);
  return row;
}

// ---------------------------------------------------------------------------
// Sub-admin management (BR-ADM-03) — full ADMIN only (enforced in
// admin.routes.ts via requireRole("admin"), not a permission scope), since
// granting/revoking another admin's access isn't itself a finance or
// moderation action.
// ---------------------------------------------------------------------------

export async function listSubAdmins(): Promise<User[]> {
  return db.select().from(users).where(eq(users.role, "sub_admin")).orderBy(desc(users.createdAt));
}

export async function createSubAdmin(
  adminId: string,
  phone: string,
  email: string,
  password: string,
  permissions: AdminPermission[],
): Promise<User> {
  if (await findUserByPhone(phone)) throw new AppError(409, "That phone number is already registered");
  if (await findUserByEmail(email)) throw new AppError(409, "That email is already registered");

  const passwordHash = await hashPassword(password);
  const [row] = await db.insert(users).values({ phone, email, passwordHash, role: "sub_admin", permissions }).returning();
  await writeAuditLog(adminId, "sub_admin.create", "user", row.id, { phone, email, permissions });
  return row;
}

export async function updateSubAdminPermissions(
  adminId: string,
  subAdminId: string,
  permissions: AdminPermission[],
): Promise<User> {
  const target = await getUserById(subAdminId);
  if (!target || target.role !== "sub_admin") throw new AppError(404, "Sub-admin not found");

  const [row] = await db
    .update(users)
    .set({ permissions, updatedAt: new Date() })
    .where(eq(users.id, subAdminId))
    .returning();
  await writeAuditLog(adminId, "sub_admin.update_permissions", "user", subAdminId, { permissions });
  return row;
}

// ---------------------------------------------------------------------------
// Audit log (BR-ADM-04) — every writeAuditLog call above lands here;
// reviewed, never edited.
// ---------------------------------------------------------------------------

// adminId/from/to (admin design's "Admin ▾"/"Date ▾" filters on the Audit
// Logs page) are all optional and composable — each condition is only
// added when its filter is actually given.
export async function listAuditLog(limit: number, adminId?: string, from?: Date, to?: Date) {
  const conditions = [
    adminId ? eq(auditLogs.adminId, adminId) : undefined,
    from ? gte(auditLogs.createdAt, from) : undefined,
    to ? lte(auditLogs.createdAt, to) : undefined,
  ].filter((c): c is SQL => c !== undefined);

  if (conditions.length === 0) {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }
  return db.select().from(auditLogs).where(and(...conditions)).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Analytics dashboard (BR-ADM-01)
// ---------------------------------------------------------------------------

async function countUsersWhere(condition: SQL): Promise<number> {
  const [{ value }] = await db.select({ value: sql<number>`count(*)::int` }).from(users).where(condition);
  return value;
}

const DEFAULT_DASHBOARD_WINDOW_DAYS = 30;

// from/to scope revenue/commission/call-minutes/the chart series/top
// earners to a period (admin design's "Last 30 days" selector) — default
// to the last 30 days when omitted, same window the design defaults to.
// Account counts (totalUsers, activeUsers, ...) are always all-time
// snapshots regardless of the period, same as before this existed.
export async function getDashboardStats(from?: Date, to?: Date) {
  const periodStart = from ?? new Date(Date.now() - DEFAULT_DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const periodEnd = to ?? new Date();

  const [totalUsers, activeUsers, totalHosts, activeHosts, pendingKycCount] = await Promise.all([
    countUsersWhere(eq(users.role, "user")),
    countUsersWhere(and(eq(users.role, "user"), eq(users.status, "active"))!),
    countUsersWhere(eq(users.role, "host")),
    countUsersWhere(and(eq(users.role, "host"), eq(users.status, "active"))!),
    countUsersWhere(eq(users.kycStatus, "pending")),
  ]);

  const [{ value: pendingWithdrawalCount }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.status, "pending"));

  const [{ value: pendingReportCount }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(moderationReports)
    .where(eq(moderationReports.status, "pending"));

  // Revenue/commission are only counted from settled money movement, within
  // the selected period — a "ringing"/"missed" call never billed anything,
  // so it's excluded. updatedAt is used as "when this call last moved
  // money" (every tick touches it, and so does completion) — calls has no
  // separate "settled at" column.
  const completedCallsInPeriod = and(eq(calls.status, "completed"), gte(calls.updatedAt, periodStart), lte(calls.updatedAt, periodEnd))!;
  const [{ callRevenuePaise, commissionPaise, callMinuteTicks }] = await db
    .select({
      callRevenuePaise: sql<number>`coalesce(sum(${calls.totalAmountPaise}), 0)::int`,
      commissionPaise: sql<number>`coalesce(sum(${calls.totalAmountPaise} - ${calls.totalBeans} * ${calls.paisePerBeanSnapshot}), 0)::int`,
      callMinuteTicks: sql<number>`coalesce(sum(${calls.tickCount}), 0)::int`,
    })
    .from(calls)
    .where(completedCallsInPeriod);

  const giftsInPeriod = and(gte(giftTransactions.createdAt, periodStart), lte(giftTransactions.createdAt, periodEnd))!;
  const [{ giftRevenuePaise, giftCommissionPaise }] = await db
    .select({
      giftRevenuePaise: sql<number>`coalesce(sum(${giftTransactions.pricePaiseSnapshot}), 0)::int`,
      giftCommissionPaise: sql<number>`coalesce(sum(${giftTransactions.pricePaiseSnapshot} - ${giftTransactions.beansCredited} * ${giftTransactions.paisePerBeanSnapshot}), 0)::int`,
    })
    .from(giftTransactions)
    .where(giftsInPeriod);

  // One row per day in the period — "Revenue (bars) · call minutes
  // (secondary series)" per the design's chart caption. Gift revenue isn't
  // broken out separately here (the chart only shows two series); it's
  // still included in the top-level revenuePaise total below.
  const series = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${calls.updatedAt}), 'YYYY-MM-DD')`,
      revenuePaise: sql<number>`coalesce(sum(${calls.totalAmountPaise}), 0)::int`,
      callMinutes: sql<number>`round(coalesce(sum(${calls.tickCount}), 0) * ${TICK_INTERVAL_MS / 1000} / 60.0)::int`,
    })
    .from(calls)
    .where(completedCallsInPeriod)
    .groupBy(sql`date_trunc('day', ${calls.updatedAt})`)
    .orderBy(sql`date_trunc('day', ${calls.updatedAt})`);

  // Top earners for the period — gross money attributable to each host
  // (their own completed calls' totalAmountPaise, plus gifts they
  // received), not their current all-time bean balance, which wouldn't
  // reflect "top earners this period" once withdrawals start moving beans
  // out of the wallet.
  const hostCallStats = await db
    .select({
      hostId: calls.hostId,
      amountPaise: sql<number>`coalesce(sum(${calls.totalAmountPaise}), 0)::int`,
      callMinutes: sql<number>`round(coalesce(sum(${calls.tickCount}), 0) * ${TICK_INTERVAL_MS / 1000} / 60.0)::int`,
    })
    .from(calls)
    .where(completedCallsInPeriod)
    .groupBy(calls.hostId);

  const hostGiftStats = await db
    .select({
      hostId: giftTransactions.recipientId,
      amountPaise: sql<number>`coalesce(sum(${giftTransactions.pricePaiseSnapshot}), 0)::int`,
    })
    .from(giftTransactions)
    .where(giftsInPeriod)
    .groupBy(giftTransactions.recipientId);

  const earningsByHostId = new Map<string, { earningsPaise: number; callMinutes: number }>();
  for (const row of hostCallStats) {
    earningsByHostId.set(row.hostId, { earningsPaise: row.amountPaise, callMinutes: row.callMinutes });
  }
  for (const row of hostGiftStats) {
    const existing = earningsByHostId.get(row.hostId) ?? { earningsPaise: 0, callMinutes: 0 };
    earningsByHostId.set(row.hostId, { ...existing, earningsPaise: existing.earningsPaise + row.amountPaise });
  }

  const topHostIds = Array.from(earningsByHostId.entries())
    .sort((a, b) => b[1].earningsPaise - a[1].earningsPaise)
    .slice(0, 10)
    .map(([hostId]) => hostId);

  const topHostUsers =
    topHostIds.length > 0
      ? await db.select({ id: users.id, name: users.name, phone: users.phone, status: users.status }).from(users).where(inArray(users.id, topHostIds))
      : [];
  const topEarningHosts = topHostIds.map((hostId) => {
    const host = topHostUsers.find((u) => u.id === hostId);
    const earnings = earningsByHostId.get(hostId)!;
    return { hostId, name: host?.name ?? null, phone: host?.phone ?? null, status: host?.status ?? null, ...earnings };
  });

  return {
    period: { from: periodStart, to: periodEnd },
    totalUsers,
    activeUsers,
    totalHosts,
    activeHosts,
    onlineHosts: listOnlineHostIds().length,
    pendingKycCount,
    pendingWithdrawalCount,
    pendingReportCount,
    revenuePaise: callRevenuePaise + giftRevenuePaise,
    commissionCollectedPaise: commissionPaise + giftCommissionPaise,
    totalCallMinutes: Math.round((callMinuteTicks * (TICK_INTERVAL_MS / 1000)) / 60),
    series,
    topEarningHosts,
  };
}

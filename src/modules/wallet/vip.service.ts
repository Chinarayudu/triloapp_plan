import { and, desc, eq, gt, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { vipConfigs, vipPlans, vipSubscriptions } from "../../db/schema";
import { AppError } from "../../lib/errors";

type VipSubscription = typeof vipSubscriptions.$inferSelect;

export async function listActiveVipPlans() {
  return db.select().from(vipPlans).where(eq(vipPlans.active, true));
}

// Versioned like commissionConfigs — see schema.ts's vipConfigs comment for
// why the rate itself is a placeholder.
export async function getVipCallDiscountBasisPoints(): Promise<number> {
  const [row] = await db
    .select()
    .from(vipConfigs)
    .where(lte(vipConfigs.effectiveFrom, new Date()))
    .orderBy(desc(vipConfigs.effectiveFrom))
    .limit(1);
  if (!row) throw new Error("No VIP config seeded — run `npm run db:seed`");
  return row.callDiscountBasisPoints;
}

// "Currently benefiting" — true from purchase through expiresAt regardless
// of cancelAtPeriodEnd (cancelling keeps benefits until the period ends,
// matching the Active Subscriptions screen's copy). Computed from expiresAt
// rather than a maintained "expired" status, same "computed on read" reasoning
// ratings.service.ts's aggregate uses — there's no background sweep to flip
// a status column here.
export async function getActiveVipSubscription(userId: string): Promise<VipSubscription | undefined> {
  const [row] = await db
    .select()
    .from(vipSubscriptions)
    .where(and(eq(vipSubscriptions.userId, userId), eq(vipSubscriptions.status, "active"), gt(vipSubscriptions.expiresAt, new Date())))
    .orderBy(desc(vipSubscriptions.expiresAt))
    .limit(1);
  return row;
}

export async function isVipActive(userId: string): Promise<boolean> {
  return Boolean(await getActiveVipSubscription(userId));
}

export async function listMySubscriptions(userId: string): Promise<VipSubscription[]> {
  return db
    .select()
    .from(vipSubscriptions)
    .where(and(eq(vipSubscriptions.userId, userId), gt(vipSubscriptions.expiresAt, new Date())))
    .orderBy(desc(vipSubscriptions.expiresAt));
}

// Dev-stubbed payment, same "no real gateway wired up yet" reasoning as
// wallet recharge — activates immediately. If already active, extends from
// the current expiry (standard renewal semantics) rather than from now, so
// resubscribing early never shortens what was already paid for.
export async function subscribeToVip(userId: string, planId: string): Promise<VipSubscription> {
  const [plan] = await db.select().from(vipPlans).where(eq(vipPlans.id, planId)).limit(1);
  if (!plan || !plan.active) throw new AppError(404, "VIP plan not found");

  const existing = await getActiveVipSubscription(userId);
  const base = existing && existing.expiresAt > new Date() ? existing.expiresAt : new Date();
  const expiresAt = new Date(base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  if (existing) {
    const [updated] = await db
      .update(vipSubscriptions)
      .set({ planId, expiresAt, cancelAtPeriodEnd: false })
      .where(eq(vipSubscriptions.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db.insert(vipSubscriptions).values({ userId, planId, expiresAt }).returning();
  return created;
}

// Keeps benefits until expiresAt — see getActiveVipSubscription's comment.
export async function cancelVipSubscription(userId: string, subscriptionId: string): Promise<VipSubscription> {
  const [existing] = await db
    .select()
    .from(vipSubscriptions)
    .where(eq(vipSubscriptions.id, subscriptionId))
    .limit(1);
  if (!existing) throw new AppError(404, "Subscription not found");
  if (existing.userId !== userId) throw new AppError(403, "Not your subscription");
  if (existing.expiresAt <= new Date()) throw new AppError(409, "Subscription already expired");

  const [updated] = await db
    .update(vipSubscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(vipSubscriptions.id, subscriptionId))
    .returning();
  return updated;
}

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { vipConfigs, vipPlans, vipPurchases, vipSubscriptions } from "../../db/schema";
import {
  cashfreeCheckoutMode,
  cashfreeCustomerId,
  cashfreeCustomerPhone,
  createCashfreeOrder,
  getCashfreeOrder,
  isCashfreePgConfigured,
} from "../../lib/cashfree";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getUserById } from "../users/users.service";

type VipSubscription = typeof vipSubscriptions.$inferSelect;
type VipPurchase = typeof vipPurchases.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

// Runs only once a purchase is paid (markVipPurchaseSuccess), inside its
// transaction. If already active, extends from the current expiry (standard
// renewal semantics) rather than from now, so resubscribing early never
// shortens what was already paid for.
async function activateVipInTx(tx: Tx, userId: string, planId: string, durationDays: number): Promise<VipSubscription> {
  const [existing] = await tx
    .select()
    .from(vipSubscriptions)
    .where(and(eq(vipSubscriptions.userId, userId), eq(vipSubscriptions.status, "active"), gt(vipSubscriptions.expiresAt, new Date())))
    .orderBy(desc(vipSubscriptions.expiresAt))
    .limit(1)
    .for("update");
  const base = existing ? existing.expiresAt : new Date();
  const expiresAt = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

  if (existing) {
    const [updated] = await tx
      .update(vipSubscriptions)
      .set({ planId, expiresAt, cancelAtPeriodEnd: false })
      .where(eq(vipSubscriptions.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await tx.insert(vipSubscriptions).values({ userId, planId, expiresAt }).returning();
  return created;
}

// POST /vip/subscribe — same lifecycle as wallet recharge (recharge.service.ts):
// creates a purchase + Cashfree order and returns the checkout session; nothing
// is activated until the payment is confirmed. Without Cashfree configured
// (local dev/tests) it's a dev-stub purchase settled by devResolveVipPurchase.
export async function initiateVipPurchase(
  userId: string,
  planId: string,
): Promise<VipPurchase & { checkoutMode: "sandbox" | "production" | null }> {
  const [plan] = await db.select().from(vipPlans).where(eq(vipPlans.id, planId)).limit(1);
  if (!plan || !plan.active) throw new AppError(404, "VIP plan not found");

  if (!isCashfreePgConfigured() && env.NODE_ENV === "production") {
    throw new Error("Cashfree PG is not configured — VIP purchase can't run in production without it");
  }

  const [purchase] = await db.insert(vipPurchases).values({ userId, planId, amountPaise: plan.pricePaise }).returning();
  if (!isCashfreePgConfigured()) return { ...purchase, checkoutMode: null };

  if (!env.USER_APP_URL) throw new Error("USER_APP_URL is required for Cashfree checkout (the return URL)");
  const user = await getUserById(userId);
  if (!user) throw new Error(`No user row for ${userId}`);

  const orderId = `vip_${purchase.id}`;
  let order;
  try {
    order = await createCashfreeOrder({
      orderId,
      amountPaise: purchase.amountPaise,
      customerId: cashfreeCustomerId(userId),
      customerPhone: cashfreeCustomerPhone(user.phone),
      returnUrl: `${env.USER_APP_URL}/vip?purchase_id=${purchase.id}`,
    });
  } catch (err) {
    logger.error({ err, vipPurchaseId: purchase.id }, "Cashfree order creation failed");
    await db.update(vipPurchases).set({ status: "failed", updatedAt: new Date() }).where(eq(vipPurchases.id, purchase.id));
    throw new AppError(502, "Payment gateway unavailable — please try again");
  }

  const [updated] = await db
    .update(vipPurchases)
    .set({ gateway: "cashfree", gatewayOrderId: orderId, paymentSessionId: order.payment_session_id, updatedAt: new Date() })
    .where(eq(vipPurchases.id, purchase.id))
    .returning();
  return { ...updated, checkoutMode: cashfreeCheckoutMode() };
}

export async function getVipPurchaseById(id: string): Promise<VipPurchase | undefined> {
  const [row] = await db.select().from(vipPurchases).where(eq(vipPurchases.id, id)).limit(1);
  return row;
}

export async function getVipPurchaseByGatewayOrderId(orderId: string): Promise<VipPurchase | undefined> {
  const [row] = await db.select().from(vipPurchases).where(eq(vipPurchases.gatewayOrderId, orderId)).limit(1);
  return row;
}

// Claim (created -> success) and activate in one transaction — a concurrent
// webhook + status check can't activate the same payment twice.
async function markVipPurchaseSuccess(id: string, gatewayTxnId: string): Promise<VipPurchase> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(vipPurchases)
      .set({ status: "success", gatewayTxnId, updatedAt: new Date() })
      .where(and(eq(vipPurchases.id, id), eq(vipPurchases.status, "created")))
      .returning();
    if (!claimed) {
      const [current] = await tx.select().from(vipPurchases).where(eq(vipPurchases.id, id)).limit(1);
      return current;
    }

    const [plan] = await tx.select().from(vipPlans).where(eq(vipPlans.id, claimed.planId)).limit(1);
    if (!plan) throw new Error(`VIP plan ${claimed.planId} missing for paid purchase ${claimed.id}`);
    const subscription = await activateVipInTx(tx, claimed.userId, claimed.planId, plan.durationDays);

    const [linked] = await tx
      .update(vipPurchases)
      .set({ subscriptionId: subscription.id })
      .where(eq(vipPurchases.id, claimed.id))
      .returning();
    return linked;
  });
}

async function markVipPurchaseFailed(id: string): Promise<VipPurchase> {
  const [updated] = await db
    .update(vipPurchases)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(vipPurchases.id, id), eq(vipPurchases.status, "created")))
    .returning();
  return updated ?? (await getVipPurchaseById(id))!;
}

// Same reasoning as recharge.service.ts's syncRechargeWithGateway.
export async function syncVipPurchaseWithGateway(purchase: VipPurchase): Promise<VipPurchase> {
  if (purchase.status !== "created" || purchase.gateway !== "cashfree" || !purchase.gatewayOrderId) return purchase;

  const order = await getCashfreeOrder(purchase.gatewayOrderId);
  if (order.order_status === "PAID") {
    if (Math.round(order.order_amount * 100) !== purchase.amountPaise || order.order_currency !== "INR") {
      throw new Error(
        `Cashfree order ${order.order_id} paid ${order.order_amount} ${order.order_currency}, expected ${purchase.amountPaise} paise INR — not activating`,
      );
    }
    return markVipPurchaseSuccess(purchase.id, order.cf_order_id);
  }
  if (order.order_status === "EXPIRED" || order.order_status === "TERMINATED") {
    return markVipPurchaseFailed(purchase.id);
  }
  return purchase;
}

// Fakes the payment outcome without Cashfree — vip.routes.ts hard-blocks it in production.
export async function devResolveVipPurchase(id: string, outcome: "success" | "failed"): Promise<VipPurchase> {
  const purchase = await getVipPurchaseById(id);
  if (!purchase) throw new AppError(404, "VIP purchase not found");
  if (purchase.status !== "created") throw new AppError(409, `Purchase is already ${purchase.status}`);
  if (outcome === "failed") return markVipPurchaseFailed(id);
  return markVipPurchaseSuccess(id, `dev-vip-${randomUUID()}`);
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

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { rechargePackages, rechargeTxns } from "../../db/schema";
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
import { creditUserWalletInTx } from "./wallet.service";

type RechargeTxn = typeof rechargeTxns.$inferSelect;

export async function listRechargePackages() {
  return db.select().from(rechargePackages).where(eq(rechargePackages.active, true));
}

// Order-creation step (BACKEND_PLAN.md §2 step 1). With Cashfree configured,
// this also creates the Cashfree order and returns its payment_session_id for
// the app's checkout. Without it (local dev/tests), the txn is a dev-stub that
// only devResolveRecharge can settle — and production refuses to run that way.
export async function initiateRecharge(
  userId: string,
  packageId: string,
): Promise<RechargeTxn & { checkoutMode: "sandbox" | "production" | null }> {
  const [pkg] = await db.select().from(rechargePackages).where(eq(rechargePackages.id, packageId)).limit(1);
  if (!pkg || !pkg.active) throw new AppError(404, "Recharge package not found");

  if (!isCashfreePgConfigured() && env.NODE_ENV === "production") {
    throw new Error("Cashfree PG is not configured — recharge can't run in production without it");
  }

  const [txn] = await db.insert(rechargeTxns).values({ userId, packageId, amountPaise: pkg.pricePaise }).returning();
  if (!isCashfreePgConfigured()) return { ...txn, checkoutMode: null };

  if (!env.USER_APP_URL) throw new Error("USER_APP_URL is required for Cashfree checkout (the return URL)");
  const user = await getUserById(userId);
  if (!user) throw new Error(`No user row for ${userId}`);

  const orderId = `rch_${txn.id}`;
  let order;
  try {
    order = await createCashfreeOrder({
      orderId,
      amountPaise: txn.amountPaise,
      customerId: cashfreeCustomerId(userId),
      customerPhone: cashfreeCustomerPhone(user.phone),
      returnUrl: `${env.USER_APP_URL}/add-balance?recharge_id=${txn.id}`,
    });
  } catch (err) {
    logger.error({ err, rechargeTxnId: txn.id }, "Cashfree order creation failed");
    await db.update(rechargeTxns).set({ status: "failed", updatedAt: new Date() }).where(eq(rechargeTxns.id, txn.id));
    throw new AppError(502, "Payment gateway unavailable — please try again");
  }

  const [updated] = await db
    .update(rechargeTxns)
    .set({ gateway: "cashfree", gatewayOrderId: orderId, paymentSessionId: order.payment_session_id, updatedAt: new Date() })
    .where(eq(rechargeTxns.id, txn.id))
    .returning();
  return { ...updated, checkoutMode: cashfreeCheckoutMode() };
}

export async function getRechargeTxnById(id: string): Promise<RechargeTxn | undefined> {
  const [row] = await db.select().from(rechargeTxns).where(eq(rechargeTxns.id, id)).limit(1);
  return row;
}

export async function getRechargeTxnByGatewayOrderId(orderId: string): Promise<RechargeTxn | undefined> {
  const [row] = await db.select().from(rechargeTxns).where(eq(rechargeTxns.gatewayOrderId, orderId)).limit(1);
  return row;
}

// The one place a recharge becomes money. Claiming the row (created -> success)
// and crediting the wallet are one transaction: a concurrent webhook + status
// check both get here, only one claims the row, and the other credits nothing.
async function markRechargeSuccess(id: string, gatewayTxnId: string): Promise<{ txn: RechargeTxn; balanceAfterPaise: number | null }> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(rechargeTxns)
      .set({ status: "success", gatewayTxnId, updatedAt: new Date() })
      .where(and(eq(rechargeTxns.id, id), eq(rechargeTxns.status, "created")))
      .returning();
    if (!claimed) {
      const [current] = await tx.select().from(rechargeTxns).where(eq(rechargeTxns.id, id)).limit(1);
      return { txn: current, balanceAfterPaise: null };
    }

    const { balanceAfter } = await creditUserWalletInTx(tx, claimed.userId, claimed.amountPaise, "recharge", claimed.id, `recharge:${claimed.id}:credit`);
    return { txn: claimed, balanceAfterPaise: balanceAfter };
  });
}

async function markRechargeFailed(id: string): Promise<RechargeTxn> {
  const [updated] = await db
    .update(rechargeTxns)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(rechargeTxns.id, id), eq(rechargeTxns.status, "created")))
    .returning();
  return updated ?? (await getRechargeTxnById(id))!;
}

// Asks Cashfree what actually happened to this order and settles accordingly.
// Called by the webhook and by GET /wallet/recharge/:id (so a late or lost
// webhook never leaves a paid user uncredited). An order whose payment failed
// stays ACTIVE at Cashfree — the user can retry in checkout — so only
// EXPIRED/TERMINATED mark the recharge failed.
export async function syncRechargeWithGateway(txn: RechargeTxn): Promise<RechargeTxn> {
  if (txn.status !== "created" || txn.gateway !== "cashfree" || !txn.gatewayOrderId) return txn;

  const order = await getCashfreeOrder(txn.gatewayOrderId);
  if (order.order_status === "PAID") {
    if (Math.round(order.order_amount * 100) !== txn.amountPaise || order.order_currency !== "INR") {
      throw new Error(
        `Cashfree order ${order.order_id} paid ${order.order_amount} ${order.order_currency}, expected ${txn.amountPaise} paise INR — not crediting`,
      );
    }
    return (await markRechargeSuccess(txn.id, order.cf_order_id)).txn;
  }
  if (order.order_status === "EXPIRED" || order.order_status === "TERMINATED") {
    return markRechargeFailed(txn.id);
  }
  return txn;
}

// Stands in for Cashfree in local dev/tests (and on the Render testing deploy,
// which runs NODE_ENV=development). wallet.routes.ts hard-blocks it in production.
export async function devResolveRecharge(
  id: string,
  outcome: "success" | "failed",
): Promise<RechargeTxn & { balanceAfterPaise: number | null }> {
  const txn = await getRechargeTxnById(id);
  if (!txn) throw new AppError(404, "Recharge transaction not found");
  if (txn.status !== "created") throw new AppError(409, `Recharge is already ${txn.status}`);

  if (outcome === "failed") {
    return { ...(await markRechargeFailed(id)), balanceAfterPaise: null };
  }
  const { txn: settled, balanceAfterPaise } = await markRechargeSuccess(id, `dev-recharge-${randomUUID()}`);
  return { ...settled, balanceAfterPaise };
}

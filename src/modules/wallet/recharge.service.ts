import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { rechargePackages, rechargeTxns } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { creditUserWallet } from "./wallet.service";

type RechargeTxn = typeof rechargeTxns.$inferSelect;

export async function listRechargePackages() {
  return db.select().from(rechargePackages).where(eq(rechargePackages.active, true));
}

// Order-creation step (BACKEND_PLAN.md §2 step 1) — the actual gateway call
// is dev-stubbed (devResolveRecharge below), same "no real gateway wired up
// yet" reasoning as withdrawal.service.ts's payout stub.
export async function initiateRecharge(userId: string, packageId: string): Promise<RechargeTxn> {
  const [pkg] = await db.select().from(rechargePackages).where(eq(rechargePackages.id, packageId)).limit(1);
  if (!pkg || !pkg.active) throw new AppError(404, "Recharge package not found");

  const [txn] = await db
    .insert(rechargeTxns)
    .values({
      userId,
      packageId,
      amountPaise: pkg.pricePaise,
      displayBeans: pkg.displayBeans,
    })
    .returning();
  return txn;
}

export async function getRechargeTxnById(id: string): Promise<RechargeTxn | undefined> {
  const [row] = await db.select().from(rechargeTxns).where(eq(rechargeTxns.id, id)).limit(1);
  return row;
}

// Stands in for the payment gateway's webhook — no real gateway is
// configured yet (BACKEND_PLAN.md §2/§3). Non-prod only (wallet.routes.ts
// hard-blocks this in production, same convention as every other dev
// escape hatch in this codebase).
export async function devResolveRecharge(
  id: string,
  outcome: "success" | "failed",
): Promise<RechargeTxn & { balanceAfterPaise: number | null }> {
  const txn = await getRechargeTxnById(id);
  if (!txn) throw new AppError(404, "Recharge transaction not found");
  if (txn.status !== "created") throw new AppError(409, `Recharge is already ${txn.status}`);

  if (outcome === "failed") {
    const [updated] = await db
      .update(rechargeTxns)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(rechargeTxns.id, id))
      .returning();
    return { ...updated, balanceAfterPaise: null };
  }

  const { balanceAfter } = await creditUserWallet(
    txn.userId,
    txn.amountPaise,
    "recharge",
    txn.id,
    `recharge:${txn.id}:credit`,
  );

  const [updated] = await db
    .update(rechargeTxns)
    .set({ status: "success", gatewayTxnId: `dev-recharge-${randomUUID()}`, updatedAt: new Date() })
    .where(eq(rechargeTxns.id, id))
    .returning();

  return { ...updated, balanceAfterPaise: balanceAfter };
}

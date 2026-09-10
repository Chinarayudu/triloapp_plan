import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { payoutMethods } from "../../db/schema";
import { AppError } from "../../lib/errors";

type PayoutMethodType = "upi" | "bank";

export async function getPrimaryPayoutMethod(hostId: string) {
  const [row] = await db
    .select()
    .from(payoutMethods)
    .where(and(eq(payoutMethods.hostId, hostId), eq(payoutMethods.isPrimary, true)))
    .limit(1);
  return row;
}

export async function listPayoutMethods(hostId: string) {
  return db.select().from(payoutMethods).where(eq(payoutMethods.hostId, hostId)).orderBy(asc(payoutMethods.createdAt));
}

// The first method a host adds becomes primary automatically — every
// subsequent one is a backup until explicitly promoted (setPrimaryPayoutMethod).
export async function addPayoutMethod(hostId: string, type: PayoutMethodType, detailsJson: string) {
  const existing = await listPayoutMethods(hostId);
  const [method] = await db
    .insert(payoutMethods)
    .values({ hostId, type, detailsJson, isPrimary: existing.length === 0 })
    .returning();
  return method;
}

// If the deleted method was primary and another remains, the oldest
// surviving one is promoted — a host always has exactly one primary method
// as long as they have at least one method at all (withdrawal.service.ts
// requires a primary to request a withdrawal).
export async function deletePayoutMethod(hostId: string, id: string): Promise<void> {
  const [method] = await db
    .select()
    .from(payoutMethods)
    .where(and(eq(payoutMethods.id, id), eq(payoutMethods.hostId, hostId)))
    .limit(1);
  if (!method) throw new AppError(404, "Payout method not found");

  await db.delete(payoutMethods).where(eq(payoutMethods.id, id));

  if (method.isPrimary) {
    const [next] = await listPayoutMethods(hostId);
    if (next) {
      await db.update(payoutMethods).set({ isPrimary: true }).where(eq(payoutMethods.id, next.id));
    }
  }
}

export async function setPrimaryPayoutMethod(hostId: string, id: string) {
  const [method] = await db
    .select()
    .from(payoutMethods)
    .where(and(eq(payoutMethods.id, id), eq(payoutMethods.hostId, hostId)))
    .limit(1);
  if (!method) throw new AppError(404, "Payout method not found");

  return db.transaction(async (tx) => {
    await tx.update(payoutMethods).set({ isPrimary: false }).where(eq(payoutMethods.hostId, hostId));
    const [updated] = await tx
      .update(payoutMethods)
      .set({ isPrimary: true })
      .where(eq(payoutMethods.id, id))
      .returning();
    return updated;
  });
}

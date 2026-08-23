import { db, pool } from "./client";
import { beansEarnConfigs, commissionConfigs, gifts, withdrawalPolicyConfigs, withdrawalSlabs } from "./schema";

// Idempotent: only inserts if the table is empty, so this is safe to run
// on every deploy rather than needing a "has this run before" tracker.
// Values here are placeholders for the business to tune via the (not yet
// built) admin config screen — 20% commission, beans tracking net paise
// 1:1 at credit time (see BACKEND_PLAN.md §1 for why the interesting
// conversion complexity lives on the withdrawal side, not here).
async function seed(): Promise<void> {
  const existingCommission = await db.select().from(commissionConfigs).limit(1);
  if (existingCommission.length === 0) {
    await db.insert(commissionConfigs).values({ basisPoints: 2000 });
    console.log("Seeded commission config: 20%");
  } else {
    console.log("Commission config already present, skipping");
  }

  const existingBeans = await db.select().from(beansEarnConfigs).limit(1);
  if (existingBeans.length === 0) {
    await db.insert(beansEarnConfigs).values({ paisePerBean: 1 });
    console.log("Seeded beans earn config: 1 paise per bean");
  } else {
    console.log("Beans earn config already present, skipping");
  }

  const existingGifts = await db.select().from(gifts).limit(1);
  if (existingGifts.length === 0) {
    await db.insert(gifts).values([
      { name: "Rose", pricePaise: 1000 },
      { name: "Heart", pricePaise: 5000 },
      { name: "Crown", pricePaise: 20000 },
    ]);
    console.log("Seeded gift catalog: Rose (₹10), Heart (₹50), Crown (₹200)");
  } else {
    console.log("Gift catalog already present, skipping");
  }

  const existingPolicy = await db.select().from(withdrawalPolicyConfigs).limit(1);
  if (existingPolicy.length === 0) {
    await db.insert(withdrawalPolicyConfigs).values({
      minAmountPaise: 500, // ₹5
      maxRequestsPerWindow: 1,
      windowDays: 7,
      autoApproveThresholdPaise: 100000, // ₹1000
    });
    console.log("Seeded withdrawal policy: min ₹5, 1 per 7 days, auto-approve under ₹1000");
  } else {
    console.log("Withdrawal policy config already present, skipping");
  }

  const existingSlabs = await db.select().from(withdrawalSlabs).limit(1);
  if (existingSlabs.length === 0) {
    await db.insert(withdrawalSlabs).values([
      { minBeans: 0, maxBeans: 49999, paisePerBean: 1 },
      { minBeans: 50000, maxBeans: null, paisePerBean: 2 },
    ]);
    console.log("Seeded withdrawal slabs: 1 paise/bean under 50k, 2 paise/bean at 50k+");
  } else {
    console.log("Withdrawal slabs already present, skipping");
  }

  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

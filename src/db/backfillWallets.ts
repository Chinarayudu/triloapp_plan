import { eq } from "drizzle-orm";
import { db, pool } from "./client";
import { hostWallets, users, wallets } from "./schema";

// One-time backfill for accounts created before the wallets/host_wallets
// tables existed (Phase 4) — new signups already get a wallet row at
// creation time (users.service.ts's createUser). Idempotent: safe to
// re-run, only inserts rows that are actually missing. Any real
// deployment that introduces a new "every user needs a satellite row"
// table needs exactly this kind of backfill for pre-existing rows.
async function backfill(): Promise<void> {
  const allUsers = await db.select().from(users);

  let walletsCreated = 0;
  let hostWalletsCreated = 0;

  for (const user of allUsers) {
    if (user.role === "user") {
      const [existing] = await db.select().from(wallets).where(eq(wallets.userId, user.id)).limit(1);
      if (!existing) {
        await db.insert(wallets).values({ userId: user.id });
        walletsCreated++;
      }
    } else if (user.role === "host") {
      const [existing] = await db.select().from(hostWallets).where(eq(hostWallets.hostId, user.id)).limit(1);
      if (!existing) {
        await db.insert(hostWallets).values({ hostId: user.id });
        hostWalletsCreated++;
      }
    }
  }

  console.log(`Backfilled ${walletsCreated} user wallets and ${hostWalletsCreated} host wallets`);
  await pool.end();
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

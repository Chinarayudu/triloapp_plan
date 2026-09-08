import { eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { wallets } from "../../db/schema";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";
import { reconcileUserWallets } from "./reconciliation.service";

describe("Wallet reconciliation (BACKEND_PLAN.md §1, Phase 11)", () => {
  it("shows no drift for a wallet whose balance only ever moved through the ledger", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 5000);

    const drift = await reconcileUserWallets();
    expect(drift.find((d) => d.ownerId === user.user.id)).toBeUndefined();
  });

  it("flags a wallet whose cached balance was changed outside the ledger", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 5000);

    // Simulates exactly the failure mode this job exists to catch: a
    // balance column changed by something other than wallet.service.ts's
    // ledger-writing helpers (a bad migration, a manual DB fix, a bug).
    await db.update(wallets).set({ balancePaise: 999999 }).where(eq(wallets.userId, user.user.id));

    const drift = await reconcileUserWallets();
    const flagged = drift.find((d) => d.ownerId === user.user.id);
    expect(flagged).toBeTruthy();
    expect(flagged!.cachedBalance).toBe(999999);
    expect(flagged!.computedBalance).toBe(5000);
    expect(flagged!.driftAmount).toBe(999999 - 5000);
  });

  it("is exposed to admins via GET /admin/reconciliation (finance permission)", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 5000);
    await db.update(wallets).set({ balancePaise: 4242 }).where(eq(wallets.userId, user.user.id));

    const moderationOnly = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const blocked = await request(app)
      .get("/admin/reconciliation")
      .set("Authorization", `Bearer ${moderationOnly.accessToken}`);
    expect(blocked.status).toBe(403);

    const admin = await registerAndLoginAdmin();
    const res = await request(app).get("/admin/reconciliation").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userDrift.some((d: { ownerId: string }) => d.ownerId === user.user.id)).toBe(true);

    // Restore, so this doesn't leave a permanently-broken wallet behind for
    // any other suite that happens to touch this account.
    await db.update(wallets).set({ balancePaise: 5000 }).where(eq(wallets.userId, user.user.id));
  });
});

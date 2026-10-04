import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

// Without Cashfree configured (vitest.config.ts blanks the keys), recharge and
// VIP are dev-stub purchases that only dev-resolve settles.
describe("Payments without Cashfree (dev-stub)", () => {
  it("recharge: initiate creates an unpaid txn with no checkout session; dev-resolve credits the wallet once", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const packages = await request(app).get("/user/wallet/recharge-packages").set(auth);
    const pkg = packages.body.packages[0];

    const initiated = await request(app).post("/user/wallet/recharge/initiate").set(auth).send({ packageId: pkg.id });
    expect(initiated.status).toBe(201);
    expect(initiated.body.status).toBe("created");
    expect(initiated.body.paymentSessionId).toBeNull();
    expect(initiated.body.checkoutMode).toBeNull();

    const resolved = await request(app).post(`/user/wallet/recharge/${initiated.body.id}/dev-resolve`).set(auth).send({ outcome: "success" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("success");
    expect(resolved.body.balanceAfterPaise).toBe(pkg.pricePaise);

    const again = await request(app).post(`/user/wallet/recharge/${initiated.body.id}/dev-resolve`).set(auth).send({ outcome: "success" });
    expect(again.status).toBe(409);
    const wallet = await request(app).get("/user/wallet").set(auth);
    expect(wallet.body.balancePaise).toBe(pkg.pricePaise);
  });

  it("VIP: subscribe creates an unpaid purchase and does NOT activate VIP until it's paid", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const plans = await request(app).get("/user/vip/plans").set(auth);
    const plan = plans.body.plans[0];

    const purchase = await request(app).post("/user/vip/subscribe").set(auth).send({ planId: plan.id });
    expect(purchase.status).toBe(201);
    expect(purchase.body.status).toBe("created");
    expect(purchase.body.amountPaise).toBe(plan.pricePaise);
    expect(purchase.body.subscriptionId).toBeNull();
    let subs = await request(app).get("/user/me/subscriptions").set(auth);
    expect(subs.body.subscriptions).toHaveLength(0);

    const paid = await request(app).post(`/user/vip/purchases/${purchase.body.id}/dev-resolve`).set(auth).send({ outcome: "success" });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("success");
    expect(paid.body.subscriptionId).toBeTruthy();
    subs = await request(app).get("/user/me/subscriptions").set(auth);
    expect(subs.body.subscriptions).toHaveLength(1);
    const me = await request(app).get("/user/me").set(auth);
    expect(me.body.isVipActive).toBe(true);
  });

  it("VIP: a failed payment never activates anything", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const plans = await request(app).get("/user/vip/plans").set(auth);
    const purchase = await request(app).post("/user/vip/subscribe").set(auth).send({ planId: plans.body.plans[0].id });

    const failed = await request(app).post(`/user/vip/purchases/${purchase.body.id}/dev-resolve`).set(auth).send({ outcome: "failed" });
    expect(failed.body.status).toBe("failed");
    const subs = await request(app).get("/user/me/subscriptions").set(auth);
    expect(subs.body.subscriptions).toHaveLength(0);
  });
});

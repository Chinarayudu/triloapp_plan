import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake Cashfree keys for this file only — set before app/env load, so the real
// Cashfree code paths run, but every HTTP call hits the fake below instead of
// the network.
vi.hoisted(() => {
  process.env.CASHFREE_PG_APP_ID = "TEST_fake_app";
  process.env.CASHFREE_PG_SECRET_KEY = "fake_secret_for_tests";
  process.env.USER_APP_URL = "https://user-app.example";
  process.env.BACKEND_PUBLIC_URL = "https://api.example";
});

import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

const SECRET = "fake_secret_for_tests";

// A fake Cashfree PG: remembers orders created through it; tests flip an order
// to PAID (or tamper with its amount) to simulate what happened in checkout.
type FakeOrder = { order_id: string; cf_order_id: string; order_amount: number; order_currency: string; order_status: string; payment_session_id: string };
let orders: Map<string, FakeOrder>;
let createBodies: Array<Record<string, any>>;

beforeEach(() => {
  orders = new Map();
  createBodies = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST" && url.endsWith("/pg/orders")) {
      const body = JSON.parse(init.body as string);
      createBodies.push(body);
      const order: FakeOrder = {
        order_id: body.order_id,
        cf_order_id: `cf_${orders.size + 1}`,
        order_amount: body.order_amount,
        order_currency: body.order_currency,
        order_status: "ACTIVE",
        payment_session_id: `session_${body.order_id}`,
      };
      orders.set(order.order_id, order);
      return new Response(JSON.stringify(order), { status: 200 });
    }
    const match = url.match(/\/pg\/orders\/([^/?]+)$/);
    if (match && orders.has(decodeURIComponent(match[1]))) {
      return new Response(JSON.stringify(orders.get(decodeURIComponent(match[1]))), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedWebhook(app: ReturnType<typeof createApp>, orderId: string, secret = SECRET) {
  const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: orderId }, payment: { payment_status: "SUCCESS" } } });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(timestamp + body).digest("base64");
  return request(app)
    .post("/payments/cashfree/webhook")
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", timestamp)
    .set("x-webhook-signature", signature)
    .send(body);
}

async function startRecharge(app: ReturnType<typeof createApp>) {
  const user = await registerAndLogin(app, "user");
  const auth = { Authorization: `Bearer ${user.accessToken}` };
  const packages = await request(app).get("/user/wallet/recharge-packages").set(auth);
  const pkg = packages.body.packages[0];
  const initiated = await request(app).post("/user/wallet/recharge/initiate").set(auth).send({ packageId: pkg.id });
  return { user, auth, pkg, initiated };
}

describe("Cashfree recharge", () => {
  it("creates a Cashfree order for the package price and returns the checkout session", async () => {
    const app = createApp();
    const { user, pkg, initiated } = await startRecharge(app);

    expect(initiated.status).toBe(201);
    expect(initiated.body.gateway).toBe("cashfree");
    expect(initiated.body.gatewayOrderId).toBe(`rch_${initiated.body.id}`);
    expect(initiated.body.paymentSessionId).toBe(`session_rch_${initiated.body.id}`);
    expect(initiated.body.checkoutMode).toBe("sandbox");

    const sent = createBodies[0];
    expect(sent.order_amount).toBe(pkg.pricePaise / 100);
    expect(sent.order_currency).toBe("INR");
    expect(sent.customer_details.customer_phone).toBe(user.user.phone.slice(-10));
    expect(sent.order_meta.return_url).toBe(`https://user-app.example/add-balance?recharge_id=${initiated.body.id}`);
    expect(sent.order_meta.notify_url).toBe("https://api.example/payments/cashfree/webhook");
  });

  it("rejects a webhook with a bad signature and credits nothing", async () => {
    const app = createApp();
    const { auth, initiated } = await startRecharge(app);
    orders.get(initiated.body.gatewayOrderId)!.order_status = "PAID";

    const forged = await signedWebhook(app, initiated.body.gatewayOrderId, "not_the_secret");
    expect(forged.status).toBe(401);
    const wallet = await request(app).get("/user/wallet").set(auth);
    expect(wallet.body.balancePaise).toBe(0);
  });

  it("credits nothing while the order is unpaid, then exactly once when paid — however many times it's confirmed", async () => {
    const app = createApp();
    const { auth, pkg, initiated } = await startRecharge(app);
    const orderId = initiated.body.gatewayOrderId;

    const early = await signedWebhook(app, orderId); // e.g. a PAYMENT_FAILED retry while the order is still ACTIVE
    expect(early.status).toBe(200);
    let wallet = await request(app).get("/user/wallet").set(auth);
    expect(wallet.body.balancePaise).toBe(0);

    orders.get(orderId)!.order_status = "PAID";
    const [webhook, poll] = await Promise.all([
      signedWebhook(app, orderId),
      request(app).get(`/user/wallet/recharge/${initiated.body.id}`).set(auth),
    ]);
    expect(webhook.status).toBe(200);
    expect(poll.status).toBe(200);
    await signedWebhook(app, orderId); // replay

    const txn = await request(app).get(`/user/wallet/recharge/${initiated.body.id}`).set(auth);
    expect(txn.body.status).toBe("success");
    wallet = await request(app).get("/user/wallet").set(auth);
    expect(wallet.body.balancePaise).toBe(pkg.pricePaise);
  });

  it("refuses to credit when Cashfree reports a different paid amount", async () => {
    const app = createApp();
    const { auth, initiated } = await startRecharge(app);
    const order = orders.get(initiated.body.gatewayOrderId)!;
    order.order_status = "PAID";
    order.order_amount = 1;

    const webhook = await signedWebhook(app, initiated.body.gatewayOrderId);
    expect(webhook.status).toBe(500); // loud — and Cashfree will retry, but it will never match
    const wallet = await request(app).get("/user/wallet").set(auth);
    expect(wallet.body.balancePaise).toBe(0);
  });

  it("marks the recharge failed once Cashfree expires the order", async () => {
    const app = createApp();
    const { auth, initiated } = await startRecharge(app);
    orders.get(initiated.body.gatewayOrderId)!.order_status = "EXPIRED";

    const txn = await request(app).get(`/user/wallet/recharge/${initiated.body.id}`).set(auth);
    expect(txn.body.status).toBe("failed");
  });
});

describe("Cashfree VIP purchase", () => {
  it("activates VIP only after the paid webhook, and only once", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const plans = await request(app).get("/user/vip/plans").set(auth);
    const plan = plans.body.plans[0];

    const purchase = await request(app).post("/user/vip/subscribe").set(auth).send({ planId: plan.id });
    expect(purchase.status).toBe(201);
    expect(purchase.body.paymentSessionId).toBe(`session_vip_${purchase.body.id}`);
    expect(createBodies[0].order_amount).toBe(plan.pricePaise / 100);
    expect(createBodies[0].order_meta.return_url).toBe(`https://user-app.example/vip?purchase_id=${purchase.body.id}`);
    let me = await request(app).get("/user/me").set(auth);
    expect(me.body.isVipActive).toBe(false);

    orders.get(purchase.body.gatewayOrderId)!.order_status = "PAID";
    await signedWebhook(app, purchase.body.gatewayOrderId);
    await signedWebhook(app, purchase.body.gatewayOrderId); // replay

    const settled = await request(app).get(`/user/vip/purchases/${purchase.body.id}`).set(auth);
    expect(settled.body.status).toBe("success");
    me = await request(app).get("/user/me").set(auth);
    expect(me.body.isVipActive).toBe(true);
    const subs = await request(app).get("/user/me/subscriptions").set(auth);
    expect(subs.body.subscriptions).toHaveLength(1);
    const days = (new Date(subs.body.subscriptions[0].expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(plan.durationDays); // extended once, not twice
  });
});

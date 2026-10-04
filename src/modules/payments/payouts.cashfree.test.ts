import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake Cashfree Payouts keys for this file only (set before env loads), with a
// real throwaway RSA key so the X-Cf-Signature code path actually runs.
vi.hoisted(() => {
  const { generateKeyPairSync } = process.getBuiltinModule("node:crypto");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CASHFREE_PAYOUT_CLIENT_ID = "CF_fake_payout_client";
  process.env.CASHFREE_PAYOUT_CLIENT_SECRET = "fake_payout_secret";
  process.env.CASHFREE_PAYOUT_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.CASHFREE_PAYOUT_PUBLIC_KEY_PATH = "";
});

import { createApp } from "../../app";
import { db } from "../../db/client";
import { hostWallets, users, withdrawalRequests } from "../../db/schema";
import { registerAndLogin } from "../../test/helpers";
import { decideWithdrawal, getWithdrawalById } from "../withdrawals/withdrawal.service";

const SECRET = "fake_payout_secret";

// A fake Cashfree Payouts API: records transfers; tests set each one's status.
type FakeTransfer = { transfer_id: string; status: string; status_description: string };
let transfers: Map<string, FakeTransfer>;
let createBodies: Array<Record<string, any>>;
let createHeaders: Array<Record<string, string>>;
let failCreate: "none" | "rejected" | "accepted_but_errored";

beforeEach(() => {
  transfers = new Map();
  createBodies = [];
  createHeaders = [];
  failCreate = "none";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST" && url.endsWith("/payout/transfers")) {
      const body = JSON.parse(init.body as string);
      createBodies.push(body);
      createHeaders.push(init.headers as Record<string, string>);
      if (failCreate === "rejected") return new Response(JSON.stringify({ message: "invalid vpa" }), { status: 400 });
      transfers.set(body.transfer_id, { transfer_id: body.transfer_id, status: "RECEIVED", status_description: "received" });
      if (failCreate === "accepted_but_errored") return new Response("gateway timeout", { status: 504 });
      return new Response(JSON.stringify(transfers.get(body.transfer_id)), { status: 200 });
    }
    const id = new URL(url).searchParams.get("transfer_id");
    if (id && transfers.has(id)) return new Response(JSON.stringify(transfers.get(id)), { status: 200 });
    return new Response(JSON.stringify({ code: "transfer_id_not_found" }), { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A pending withdrawal of `beans`, with those beans already debited (balance 0),
// exactly as requestWithdrawal leaves it — inserted directly so these tests
// don't depend on whichever withdrawal policy/slab rows the shared test DB has.
async function pendingWithdrawal(app: ReturnType<typeof createApp>, beans = 5000) {
  const host = await registerAndLogin(app, "host");
  await db.update(users).set({ name: "Priya S. (Host)" }).where(eq(users.id, host.user.id));
  await db.update(hostWallets).set({ beanBalance: 0 }).where(eq(hostWallets.hostId, host.user.id));
  const [row] = await db
    .insert(withdrawalRequests)
    .values({
      hostId: host.user.id,
      beans,
      paisePerBeanSnapshot: 1,
      convertedAmountPaise: beans,
      processingFeePaise: 0,
      tdsPaise: 0,
      netPayoutPaise: beans,
      status: "pending",
      payoutDetailsSnapshot: JSON.stringify({ type: "upi", vpa: "priya@upi" }),
    })
    .returning();
  return { host, row };
}

function payoutWebhook(app: ReturnType<typeof createApp>, transferId: string, secret = SECRET) {
  const body = JSON.stringify({ type: "TRANSFER_SUCCESS", data: { transfer_id: transferId } });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(timestamp + body).digest("base64");
  return request(app)
    .post("/payments/cashfree/payout-webhook")
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", timestamp)
    .set("x-webhook-signature", signature)
    .send(body);
}

async function beanBalance(hostId: string): Promise<number> {
  const [wallet] = await db.select().from(hostWallets).where(eq(hostWallets.hostId, hostId));
  return wallet.beanBalance;
}

describe("Cashfree payouts (host withdrawals)", () => {
  it("approving starts a signed Cashfree transfer of the net amount to the host's UPI", async () => {
    const app = createApp();
    const { row } = await pendingWithdrawal(app);

    const processing = await decideWithdrawal(row.id, "approve");
    expect(processing.status).toBe("processing");
    expect(processing.payoutTxnId).toBe(`wd_${row.id.replace(/-/g, "")}`);

    const sent = createBodies[0];
    expect(sent.transfer_id).toBe(processing.payoutTxnId);
    expect(sent.transfer_amount).toBe(50); // 5000 paise
    expect(sent.transfer_mode).toBe("upi");
    expect(sent.beneficiary_details).toEqual({ beneficiary_name: "Priya S Host", beneficiary_instrument_details: { vpa: "priya@upi" } });
    expect(createHeaders[0]["x-cf-signature"]).toBeTruthy();
  });

  it("marks it paid only once Cashfree reports SUCCESS, and rejects forged webhooks", async () => {
    const app = createApp();
    const { row } = await pendingWithdrawal(app);
    const { payoutTxnId } = await decideWithdrawal(row.id, "approve");

    expect((await payoutWebhook(app, payoutTxnId!)).status).toBe(200); // still RECEIVED
    expect((await getWithdrawalById(row.id))!.status).toBe("processing");

    transfers.get(payoutTxnId!)!.status = "SUCCESS";
    expect((await payoutWebhook(app, payoutTxnId!, "wrong_secret")).status).toBe(401);
    expect((await getWithdrawalById(row.id))!.status).toBe("processing");

    await payoutWebhook(app, payoutTxnId!);
    await payoutWebhook(app, payoutTxnId!); // replay
    expect((await getWithdrawalById(row.id))!.status).toBe("paid");
  });

  it("a failed transfer fails the request and returns the beans exactly once", async () => {
    const app = createApp();
    const { host, row } = await pendingWithdrawal(app, 5000);
    const { payoutTxnId } = await decideWithdrawal(row.id, "approve");

    transfers.get(payoutTxnId!)!.status = "FAILED";
    transfers.get(payoutTxnId!)!.status_description = "Beneficiary bank offline";
    await Promise.all([
      payoutWebhook(app, payoutTxnId!),
      request(app).get(`/host/withdrawals/${row.id}`).set("Authorization", `Bearer ${host.accessToken}`),
    ]);
    await payoutWebhook(app, payoutTxnId!);

    const failed = (await getWithdrawalById(row.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("Beneficiary bank offline");
    expect(await beanBalance(host.user.id)).toBe(5000);
  });

  it("a transfer reversed after success returns the beans", async () => {
    const app = createApp();
    const { host, row } = await pendingWithdrawal(app, 5000);
    const { payoutTxnId } = await decideWithdrawal(row.id, "approve");
    transfers.get(payoutTxnId!)!.status = "SUCCESS";
    await payoutWebhook(app, payoutTxnId!);
    expect((await getWithdrawalById(row.id))!.status).toBe("paid");

    transfers.get(payoutTxnId!)!.status = "REVERSED";
    await payoutWebhook(app, payoutTxnId!);
    expect((await getWithdrawalById(row.id))!.status).toBe("failed");
    expect(await beanBalance(host.user.id)).toBe(5000);
  });

  it("if Cashfree rejects the transfer outright, the request fails and the beans come back", async () => {
    const app = createApp();
    const { host, row } = await pendingWithdrawal(app, 5000);
    failCreate = "rejected";

    const result = await decideWithdrawal(row.id, "approve");
    expect(result.status).toBe("failed");
    expect(await beanBalance(host.user.id)).toBe(5000);
  });

  it("if the transfer call errors but Cashfree did accept it, it stays processing — no beans returned on a guess", async () => {
    const app = createApp();
    const { host, row } = await pendingWithdrawal(app, 5000);
    failCreate = "accepted_but_errored";

    const result = await decideWithdrawal(row.id, "approve");
    expect(result.status).toBe("processing");
    expect(result.payoutTxnId).toBe(`wd_${row.id.replace(/-/g, "")}`);
    expect(await beanBalance(host.user.id)).toBe(0);
  });

  it("dev-resolve can't fake the outcome of a real Cashfree payout", async () => {
    const app = createApp();
    const { host, row } = await pendingWithdrawal(app);
    await decideWithdrawal(row.id, "approve");

    const res = await request(app)
      .post(`/host/withdrawals/${row.id}/dev-resolve-payout`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ outcome: "paid" });
    expect(res.status).toBe(409);
  });
});

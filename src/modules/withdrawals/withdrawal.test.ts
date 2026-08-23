import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

// Same "test against the real dependency" philosophy as kyc.test.ts — KYC
// approval is a real precondition for a withdrawal (BR-EARN-03), so it's
// exercised through a real S3 round trip rather than faked.
const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
});

async function approveHostKyc(app: ReturnType<typeof createApp>, hostAccessToken: string): Promise<string> {
  const uploadUrlRes = await request(app)
    .post("/me/kyc/upload-url")
    .set("Authorization", `Bearer ${hostAccessToken}`)
    .send({ contentType: "application/pdf" });
  await fetch(uploadUrlRes.body.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: "fake kyc document for withdrawal tests",
  });
  await request(app).post("/me/kyc").set("Authorization", `Bearer ${hostAccessToken}`).send({ key: uploadUrlRes.body.key });
  const approveRes = await request(app).post("/me/kyc/dev-approve").set("Authorization", `Bearer ${hostAccessToken}`);
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.kycStatus).toBe("approved");
  return uploadUrlRes.body.key as string;
}

async function setPayoutDetails(app: ReturnType<typeof createApp>, hostAccessToken: string): Promise<void> {
  const res = await request(app)
    .patch("/me/payout-details")
    .set("Authorization", `Bearer ${hostAccessToken}`)
    .send({ type: "upi", vpa: "host@upi" });
  expect(res.status).toBe(200);
}

// Beans only enter a host wallet through a real money-moving flow — reuses
// gift sending (the cheapest existing path) rather than a dev-only bean
// credit, since none exists (nor should one: unlike currency, there's no
// legitimate reason a host wallet needs a direct top-up escape hatch).
async function fundHostBeans(
  app: ReturnType<typeof createApp>,
  hostAccessToken: string,
  hostUserId: string,
  targetBeans: number,
): Promise<number> {
  const sender = await registerAndLogin(app, "user");
  const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${sender.accessToken}`);
  const crown = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Crown");

  let beanBalance = 0;
  while (beanBalance < targetBeans) {
    await fundUserWallet(app, sender.accessToken, crown.pricePaise);
    await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: hostUserId, giftId: crown.id });
    const walletRes = await request(app).get("/wallet").set("Authorization", `Bearer ${hostAccessToken}`);
    beanBalance = walletRes.body.beanBalance;
  }
  return beanBalance;
}

describe("Withdrawals", () => {
  const cleanupKeys: string[] = [];

  afterEach(async () => {
    while (cleanupKeys.length > 0) {
      const key = cleanupKeys.pop()!;
      await s3.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }));
    }
  });

  it("rejects a withdrawal request when KYC isn't approved", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const res = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 5000 });
    expect(res.status).toBe(403);
  });

  it("rejects a withdrawal request when no payout details are on file", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));

    const res = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 5000 });
    expect(res.status).toBe(403);
  });

  it("rejects a withdrawal below the minimum amount", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    await fundHostBeans(app, host.accessToken, host.user.id, 100);

    // Min withdrawal is ₹50 (5000 paise); at 1 paise/bean, 100 beans is
    // nowhere near it.
    const res = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 100 });
    expect(res.status).toBe(400);
  });

  it("only hosts can request a withdrawal", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const res = await request(app).post("/withdrawals").set("Authorization", `Bearer ${user.accessToken}`).send({ beans: 5000 });
    expect(res.status).toBe(403);
  });

  it("auto-approves and initiates payout for a request under the threshold, debiting beans immediately", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    const beanBalance = await fundHostBeans(app, host.accessToken, host.user.id, 6000);

    const res = await request(app)
      .post("/withdrawals")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ beans: 6000 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processing");
    expect(res.body.convertedAmountPaise).toBe(6000); // 1 paise/bean tier
    expect(res.body.payoutTxnId).toMatch(/^dev-payout-/);

    const walletRes = await request(app).get("/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    expect(walletRes.body.beanBalance).toBe(beanBalance - 6000);
  });

  it("queues a request above the auto-approve threshold for manual approval, then processes it via dev-admin-decision", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    // 50,001 beans crosses into the 2-paise/bean tier -> ₹1000.02, above
    // the ₹1000 auto-approve threshold.
    await fundHostBeans(app, host.accessToken, host.user.id, 50001);

    const created = await request(app)
      .post("/withdrawals")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ beans: 50001 });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    expect(created.body.convertedAmountPaise).toBe(100002);

    const approved = await request(app)
      .post(`/withdrawals/${created.body.id}/dev-admin-decision`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("processing");
    expect(approved.body.payoutTxnId).toBeTruthy();
  });

  it("reverses beans when a pending request is rejected", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    const beanBalance = await fundHostBeans(app, host.accessToken, host.user.id, 50001);

    const created = await request(app)
      .post("/withdrawals")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ beans: 50001 });

    const rejected = await request(app)
      .post(`/withdrawals/${created.body.id}/dev-admin-decision`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ decision: "reject" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");

    const walletRes = await request(app).get("/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    expect(walletRes.body.beanBalance).toBe(beanBalance);
  });

  it("finalizes a processing payout as paid via dev-resolve-payout", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    await fundHostBeans(app, host.accessToken, host.user.id, 6000);

    const created = await request(app)
      .post("/withdrawals")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ beans: 6000 });
    expect(created.body.status).toBe("processing");

    const resolved = await request(app)
      .post(`/withdrawals/${created.body.id}/dev-resolve-payout`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ outcome: "paid" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("paid");
  });

  it("reverses beans when a processing payout fails (BR-EARN-06)", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    const beanBalance = await fundHostBeans(app, host.accessToken, host.user.id, 6000);

    const created = await request(app)
      .post("/withdrawals")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ beans: 6000 });

    const resolved = await request(app)
      .post(`/withdrawals/${created.body.id}/dev-resolve-payout`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ outcome: "failed", reason: "Bank account rejected the transfer" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("failed");
    expect(resolved.body.failureReason).toBe("Bank account rejected the transfer");

    const walletRes = await request(app).get("/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    expect(walletRes.body.beanBalance).toBe(beanBalance - 6000 + 6000); // debited then reversed
  });

  it("enforces the withdrawal frequency cap", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    await fundHostBeans(app, host.accessToken, host.user.id, 12000);

    const first = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 6000 });
    expect(first.status).toBe(201);

    const second = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 6000 });
    expect(second.status).toBe(429);
  });

  it("lists a host's own withdrawal requests and blocks viewing someone else's", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");
    cleanupKeys.push(await approveHostKyc(app, host.accessToken));
    await setPayoutDetails(app, host.accessToken);
    await fundHostBeans(app, host.accessToken, host.user.id, 6000);

    const created = await request(app).post("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`).send({ beans: 6000 });

    const list = await request(app).get("/withdrawals").set("Authorization", `Bearer ${host.accessToken}`);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].id).toBe(created.body.id);

    const forbidden = await request(app)
      .get(`/withdrawals/${created.body.id}`)
      .set("Authorization", `Bearer ${otherHost.accessToken}`);
    expect(forbidden.status).toBe(403);
  });
});

describe("Payout details", () => {
  it("accepts a UPI payout detail and rejects an invalid IFSC for bank details", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");

    const upi = await request(app)
      .patch("/me/payout-details")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ type: "upi", vpa: "host@okhdfcbank" });
    expect(upi.status).toBe(200);
    expect(upi.body.payoutDetails).toEqual({ type: "upi", vpa: "host@okhdfcbank" });

    const badIfsc = await request(app)
      .patch("/me/payout-details")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ type: "bank", accountHolderName: "Test Host", accountNumber: "1234567890", ifsc: "not-an-ifsc" });
    expect(badIfsc.status).toBe(400);
  });

  it("rejects a non-host setting payout details", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const res = await request(app)
      .patch("/me/payout-details")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ type: "upi", vpa: "user@upi" });
    expect(res.status).toBe(403);
  });
});

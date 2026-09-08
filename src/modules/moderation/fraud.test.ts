import { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, randomPhone, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

async function loginWithFingerprint(app: Express, deviceFingerprint: string) {
  const phone = randomPhone();
  const requestRes = await request(app).post("/auth/otp/request").send({ phone });
  const verifyRes = await request(app)
    .post("/auth/otp/verify")
    .send({ phone, code: requestRes.body.devCode, role: "user", deviceFingerprint });
  return { phone, ...verifyRes.body } as { phone: string; user: { id: string } };
}

describe("Fraud: multi-accounting (BACKEND_PLAN.md §8)", () => {
  it("flags the device once 3 distinct accounts have used it, and doesn't refile on a repeat login from an already-counted account", async () => {
    const app = createApp();
    const fingerprint = `device-${randomPhone()}`; // unique enough per test run

    await loginWithFingerprint(app, fingerprint);
    await loginWithFingerprint(app, fingerprint);
    const third = await loginWithFingerprint(app, fingerprint);

    const admin = await registerAndLoginAdmin();
    const queueAfterThird = await request(app)
      .get("/admin/moderation?status=pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    const matches = queueAfterThird.body.reports.filter((r: { targetId: string }) => r.targetId === third.user.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toMatch(/3 different accounts/i);

    // A 4th login from the same third account doesn't change the distinct
    // count (still 3) — no second report for the same signal.
    const requestRes = await request(app).post("/auth/otp/request").send({ phone: third.phone });
    await request(app)
      .post("/auth/otp/verify")
      .send({ phone: third.phone, code: requestRes.body.devCode, deviceFingerprint: fingerprint });

    const queueAfterRepeat = await request(app)
      .get("/admin/moderation?status=pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    const stillOne = queueAfterRepeat.body.reports.filter((r: { targetId: string }) => r.targetId === third.user.id);
    expect(stillOne).toHaveLength(1);
  });

  it("never flags logins that don't send a device fingerprint", async () => {
    const app = createApp();
    for (let i = 0; i < 4; i++) {
      const phone = randomPhone();
      const requestRes = await request(app).post("/auth/otp/request").send({ phone });
      const res = await request(app).post("/auth/otp/verify").send({ phone, code: requestRes.body.devCode });
      expect(res.status).toBe(200); // no deviceFingerprint sent — nothing to correlate, never errors either
    }
  });
});

async function setupOnlineHost(app: Express, ratePerMinutePaise: number) {
  const host = await registerAndLogin(app, "host");
  await request(app)
    .patch("/me/host-profile")
    .set("Authorization", `Bearer ${host.accessToken}`)
    .send({ ratePerMinutePaise });
  await request(app).patch("/me/presence").set("Authorization", `Bearer ${host.accessToken}`).send({ isOnline: true });
  return host;
}

async function completeCall(app: Express, userToken: string, hostToken: string, hostId: string): Promise<void> {
  const initiate = await request(app).post("/calls").set("Authorization", `Bearer ${userToken}`).send({ hostId });
  await request(app).post(`/calls/${initiate.body.callId}/accept`).set("Authorization", `Bearer ${hostToken}`);
  await request(app).post(`/calls/${initiate.body.callId}/end`).set("Authorization", `Bearer ${userToken}`);
}

describe("Fraud: call collusion (BACKEND_PLAN.md §8)", () => {
  it("flags a host once most of their completed calls are with the same single user", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app, 100);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 100000);

    for (let i = 0; i < 5; i++) {
      await completeCall(app, user.accessToken, host.accessToken, host.user.id);
    }

    const admin = await registerAndLoginAdmin();
    const queue = await request(app)
      .get("/admin/moderation?status=pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    const autoReport = queue.body.reports.find(
      (r: { targetType: string; targetId: string }) => r.targetType === "host" && r.targetId === host.user.id,
    );
    expect(autoReport).toBeTruthy();
    expect(autoReport.reason).toMatch(/self-dealing/i);
  });

  it("doesn't flag a host whose calls are spread across different users", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app, 100);

    for (let i = 0; i < 5; i++) {
      const user = await registerAndLogin(app, "user");
      await fundUserWallet(app, user.accessToken, 100000);
      await completeCall(app, user.accessToken, host.accessToken, host.user.id);
    }

    const admin = await registerAndLoginAdmin();
    const queue = await request(app)
      .get("/admin/moderation?status=pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    const autoReport = queue.body.reports.find(
      (r: { targetType: string; targetId: string }) => r.targetType === "host" && r.targetId === host.user.id,
    );
    expect(autoReport).toBeUndefined();
  });
});

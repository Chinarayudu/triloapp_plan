import { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";
import { expireRinging, runBillingTick } from "./calls.service";

// A new host is Level 1: ₹30/min video (hosts/levels.ts) — hosts can't set their own rate.
async function setupOnlineHost(app: Express) {
  const host = await registerAndLogin(app, "host");
  await request(app)
    .patch("/host/me/presence")
    .set("Authorization", `Bearer ${host.accessToken}`)
    .send({ isOnline: true });
  return host;
}

describe("Calls: happy path with full billing reconciliation", () => {
  it("initiates, accepts, bills three ticks correctly, and ends with matching totals", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app); // ₹30/min (Level 1 video) -> 500 paise per 10s tick
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    expect(initiate.status).toBe(201);
    expect(initiate.body.status).toBe("ringing");
    expect(initiate.body.secureMode).toBe(true); // BR-MOD-03 — always true for 1:1 calls
    const callId = initiate.body.callId as string;

    const accept = await request(app)
      .post(`/host/calls/${callId}/accept`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("ongoing");

    for (let i = 0; i < 3; i++) {
      const result = await runBillingTick(callId);
      expect(result.billed).toBe(true);
    }

    const userWallet = await request(app).get("/user/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(userWallet.body.balancePaise).toBe(10000 - 1500); // 3 ticks * 500 paise

    const hostWallet = await request(app).get("/host/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    // commission is 20% (seeded default): 500 paise/tick -> 100 commission, 400 net -> 400 beans (1:1)
    expect(hostWallet.body.beanBalance).toBe(400 * 3);

    const end = await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(end.status).toBe(200);
    expect(end.body.status).toBe("completed");
    expect(end.body.totalAmountPaise).toBe(1500);
    expect(end.body.totalBeans).toBe(1200);

    const fetched = await request(app).get(`/user/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(fetched.body.tickCount).toBe(3);
    expect(fetched.body.endReason).toBe("ended_by_user");

    // Ending an already-completed call is rejected, not silently accepted.
    const doubleEnd = await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(doubleEnd.status).toBe(409);
  });
});

describe("Calls: gating and concurrency", () => {
  it("rejects initiating a call when the user has insufficient balance", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app);
    const user = await registerAndLogin(app, "user"); // unfunded

    const res = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    expect(res.status).toBe(402);
  });

  it("rejects initiating a call to a host who is not online", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    // presence never toggled on

    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const res = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not online/i);
  });

  it("blocks a second concurrent call from the same user", async () => {
    const app = createApp();
    const host1 = await setupOnlineHost(app);
    const host2 = await setupOnlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const first = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host1.user.id });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host2.user.id });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already have an active call/i);
  });

  it("blocks a call to a host who is already on another call", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app);
    const user1 = await registerAndLogin(app, "user");
    const user2 = await registerAndLogin(app, "user");
    await fundUserWallet(app, user1.accessToken, 10000);
    await fundUserWallet(app, user2.accessToken, 10000);

    const first = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ hostId: host.user.id });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user2.accessToken}`)
      .send({ hostId: host.user.id });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/busy/i);
  });
});

describe("Calls: reject and ringing timeout", () => {
  it("lets the host reject a ringing call", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    const reject = await request(app)
      .post(`/host/calls/${callId}/reject`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");

    const fetched = await request(app).get(`/user/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(fetched.body.totalAmountPaise).toBe(0);
  });

  it("marks a call missed when the ringing timeout fires before the host answers", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    // Directly invoke the timeout handler instead of waiting on the real
    // RINGING_TIMEOUT_MS timer — see calls.service.ts's comment on why
    // this is exported.
    await expireRinging(callId);

    const fetched = await request(app).get(`/user/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(fetched.body.status).toBe("missed");
    expect(fetched.body.endReason).toBe("no_answer");

    // A host trying to accept after the timeout gets a clear conflict, not a stale success.
    const lateAccept = await request(app)
      .post(`/host/calls/${callId}/accept`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(lateAccept.status).toBe(409);
  });
});

describe("Calls: mid-call low balance", () => {
  it("warns then auto-ends the call when the wallet can no longer cover a full tick", async () => {
    const app = createApp();
    // ₹30/min -> pre-call gate needs >= 3000 paise (1 minute), tick cost = 500 paise/10s.
    // 3250 paise covers exactly 6 ticks (3000) with 250 left over — the 7th tick can't be covered.
    const host = await setupOnlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 3250);

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;
    await request(app).post(`/host/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);

    for (let i = 0; i < 6; i++) {
      const result = await runBillingTick(callId);
      expect(result.billed).toBe(true);
    }

    const midCall = await request(app).get(`/user/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(midCall.body.status).toBe("ongoing");
    expect(midCall.body.totalAmountPaise).toBe(3000);

    const seventhTick = await runBillingTick(callId);
    expect(seventhTick.billed).toBe(false);

    const ended = await request(app).get(`/user/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(ended.body.status).toBe("completed");
    expect(ended.body.endReason).toBe("insufficient_balance");
    expect(ended.body.totalAmountPaise).toBe(3000); // unchanged — the 7th tick never billed

    const wallet = await request(app).get("/user/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(wallet.body.balancePaise).toBe(250); // 3250 - 3000, the uncoverable remainder is left alone
  });
});

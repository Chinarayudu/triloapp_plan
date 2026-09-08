import { Express } from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";
import { reapStaleCalls } from "./callReaper";

async function setupOnlineHost(app: Express, ratePerMinutePaise: number) {
  const host = await registerAndLogin(app, "host");
  await request(app)
    .patch("/me/host-profile")
    .set("Authorization", `Bearer ${host.accessToken}`)
    .send({ ratePerMinutePaise });
  await request(app).patch("/me/presence").set("Authorization", `Bearer ${host.accessToken}`).send({ isOnline: true });
  return host;
}

// No real timers involved — same "drive it deterministically" philosophy
// as calls.test.ts's direct runBillingTick/expireRinging calls. Here the
// staleness is backdated directly in the DB rather than waited for, since
// the reaper only ever looks at row timestamps, never in-memory timer state.
async function backdateCallTimestamp(callId: string, column: "createdAt" | "updatedAt", msAgo: number): Promise<void> {
  await db
    .update(calls)
    .set({ [column]: new Date(Date.now() - msAgo) })
    .where(eq(calls.id, callId));
}

describe("Call reaper (BACKEND_PLAN.md §8 'Mid-call failure')", () => {
  it("reaps a stale ringing call as missed", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app, 6000);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    await backdateCallTimestamp(callId, "createdAt", 20 * 60_000);

    const result = await reapStaleCalls();
    expect(result.reapedRinging).toBeGreaterThanOrEqual(1);

    const call = await request(app).get(`/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(call.body.status).toBe("missed");
    expect(call.body.endReason).toBe("reaped_stale_ringing");
  });

  it("reaps a stale ongoing call as completed, keeping whatever billing already happened", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app, 6000);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    await request(app).post(`/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);

    // Backdate past STALE_ONGOING_MS (3x the fixed 10s tick interval) — no
    // ticks are actually driven here, since this is testing recovery from a
    // dead timer, not the billing math itself (calls.test.ts covers that).
    await backdateCallTimestamp(callId, "updatedAt", 60_000);

    const result = await reapStaleCalls();
    expect(result.reapedOngoing).toBeGreaterThanOrEqual(1);

    const call = await request(app).get(`/calls/${callId}`).set("Authorization", `Bearer ${host.accessToken}`);
    expect(call.body.status).toBe("completed");
    expect(call.body.endReason).toBe("reaped_stale_ongoing");
    expect(call.body.totalAmountPaise).toBe(0); // no ticks were driven — nothing was billed, nothing lost either
  });

  it("leaves a fresh ringing/ongoing call alone", async () => {
    const app = createApp();
    const host = await setupOnlineHost(app, 6000);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const initiate = await request(app)
      .post("/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    await reapStaleCalls();

    const call = await request(app).get(`/calls/${callId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(call.body.status).toBe("ringing");
  });
});

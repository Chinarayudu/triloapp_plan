import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { registerAndLogin } from "../../test/helpers";
import {
  clearRingingTimeout,
  clearTickInProgress,
  closeCallTimerQueue,
  scheduleRingingTimeout,
  startBillingInterval,
  startCallTimerWorker,
  tryStartTick,
} from "./callTimers";

// Redis mode only (npm run test:redis). The rest of the suite drives billing
// ticks and ring timeouts by calling them directly; this runs the real BullMQ
// job chain the server uses, with short intervals and recording handlers in
// place of runBillingTick/expireRinging.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!process.env.REDIS_URL)("Call timers on Redis (BullMQ)", () => {
  const app = createApp();
  const ticks: Array<{ callId: string; at: number }> = [];
  const rings: string[] = [];
  let worker: ReturnType<typeof startCallTimerWorker>;

  async function insertCall(status: "ringing" | "ongoing"): Promise<string> {
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const [call] = await db
      .insert(calls)
      .values({
        userId: user.user.id,
        hostId: host.user.id,
        status,
        ratePerMinutePaiseSnapshot: 600,
        commissionBasisPointsSnapshot: 3000,
        paisePerBeanSnapshot: 1,
      })
      .returning();
    return call.id;
  }

  beforeAll(() => {
    worker = startCallTimerWorker({
      onTick: async (callId) => void ticks.push({ callId, at: Date.now() }),
      onRingingTimeout: async (callId) => void rings.push(callId),
    });
  });

  afterAll(async () => {
    await worker?.close();
    await closeCallTimerQueue();
  });

  it("ticks once per interval while the call is ongoing, without drift, and stops once it isn't", async () => {
    const callId = await insertCall("ongoing");
    const startedAt = Date.now();
    await startBillingInterval(callId, () => {}, 400);

    await sleep(1_500);
    const mine = ticks.filter((t) => t.callId === callId);
    expect(mine).toHaveLength(3);
    // Each tick is due one interval after the previous one was due — first
    // one interval after start, as with setInterval.
    mine.forEach((tick, i) => {
      expect(tick.at - startedAt).toBeGreaterThanOrEqual(400 * (i + 1) - 20);
      expect(tick.at - startedAt).toBeLessThan(400 * (i + 1) + 250);
    });

    await db.update(calls).set({ status: "completed" }).where(eq(calls.id, callId));
    // At most the one tick already scheduled still runs (and would find the
    // call completed); nothing after that.
    await sleep(1_200);
    expect(ticks.filter((t) => t.callId === callId).length).toBeLessThanOrEqual(4);
    const countAfterEnd = ticks.filter((t) => t.callId === callId).length;
    await sleep(900);
    expect(ticks.filter((t) => t.callId === callId)).toHaveLength(countAfterEnd);
  });

  it("fires a ringing timeout once, and never after it's cleared", async () => {
    const expiring = await insertCall("ringing");
    const answered = await insertCall("ringing");
    await scheduleRingingTimeout(expiring, () => {}, 300);
    await scheduleRingingTimeout(answered, () => {}, 300);
    await clearRingingTimeout(answered);

    await sleep(1_000);
    expect(rings.filter((id) => id === expiring)).toHaveLength(1);
    expect(rings).not.toContain(answered);
  });

  it("lets only one tick per call run at a time, across instances", async () => {
    const callId = await insertCall("ongoing");
    expect(await tryStartTick(callId)).toBe(true);
    expect(await tryStartTick(callId)).toBe(false);
    await clearTickInProgress(callId);
    expect(await tryStartTick(callId)).toBe(true);
    await clearTickInProgress(callId);
  });
});

import { Job, Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { logger } from "../../lib/logger";
import { getRedis, newRedisConnection, redisEnabled } from "../../lib/redis";

// Per-call billing ticks and ringing timeouts, in one of two places:
//
// - Without Redis: this process's timers (setInterval/setTimeout). A restart
//   loses them; callReaper.ts ends any call left without a live timer.
// - With Redis: BullMQ jobs on the "call-timers" queue, processed by whichever
//   instance's worker picks them up (startCallTimerWorker, started in
//   server.ts). They survive restarts and work across several instances.
//
// The billing math itself is untouched either way: every tick runs
// calls.service.ts's runBillingTick, which charges one fixed 10-second tick
// under a per-tick idempotency key, so a tick can never be charged twice.

const billingIntervals = new Map<string, NodeJS.Timeout>();
const ringingTimeouts = new Map<string, NodeJS.Timeout>();
const ticksInProgress = new Set<string>();

const QUEUE_NAME = "call-timers";
// Only there so a crashed tick's lock expires. Far longer than a tick takes,
// and shorter than callReaper.ts's 30s staleness window so a leaked lock can't
// stall a call long enough to get it reaped. (Even if a very slow tick outlived
// it, the per-tick idempotency key still stops a second charge.)
const TICK_LOCK_MS = 20_000;

type TickJob = { callId: string; dueAt: number; intervalMs: number };

let queue: Queue | null = null;
function timerQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: newRedisConnection() });
  return queue;
}

async function addTickJob(tick: TickJob): Promise<void> {
  await timerQueue().add("bill", tick, {
    jobId: `bill-${tick.callId}-${tick.dueAt}`,
    delay: Math.max(0, tick.dueAt - Date.now()),
    removeOnComplete: true,
    removeOnFail: 1000,
  });
}

// `onTick` runs in-process without Redis. With Redis, the worker registered at
// boot (startCallTimerWorker) runs the tick instead.
export async function startBillingInterval(callId: string, onTick: () => void, intervalMs: number): Promise<void> {
  if (redisEnabled()) {
    // The first tick is due one interval after the call connects, same as setInterval.
    await addTickJob({ callId, dueAt: Date.now() + intervalMs, intervalMs });
    return;
  }
  stopMemoryBillingInterval(callId);
  // .unref() so a live call never blocks process shutdown by itself — the
  // HTTP server's listening socket is what keeps a real server alive, not
  // this timer. It does matter for tests/scripts: without it, one leftover
  // ringing/ongoing call would hang the process on exit.
  billingIntervals.set(callId, setInterval(onTick, intervalMs).unref());
}

// With Redis there's nothing to cancel: the next tick job finds the call no
// longer ongoing, charges nothing, and doesn't schedule another.
export async function stopBillingInterval(callId: string): Promise<void> {
  if (redisEnabled()) return;
  stopMemoryBillingInterval(callId);
}

function stopMemoryBillingInterval(callId: string): void {
  const handle = billingIntervals.get(callId);
  if (handle) {
    clearInterval(handle);
    billingIntervals.delete(callId);
  }
}

export async function scheduleRingingTimeout(callId: string, onTimeout: () => void, timeoutMs: number): Promise<void> {
  if (redisEnabled()) {
    await timerQueue().add("ring", { callId }, { jobId: `ring-${callId}`, delay: timeoutMs, removeOnComplete: true, removeOnFail: 1000 });
    return;
  }
  await clearRingingTimeout(callId);
  ringingTimeouts.set(callId, setTimeout(onTimeout, timeoutMs).unref());
}

// Never throws: expireRinging does nothing once the call isn't ringing, so a
// timeout job that couldn't be removed is harmless.
export async function clearRingingTimeout(callId: string): Promise<void> {
  if (redisEnabled()) {
    await timerQueue()
      .remove(`ring-${callId}`)
      .catch((err) => logger.error({ err, callId }, "Could not remove a ringing-timeout job"));
    return;
  }
  const handle = ringingTimeouts.get(callId);
  if (handle) {
    clearTimeout(handle);
    ringingTimeouts.delete(callId);
  }
}

// True + marks in-progress if no tick for this call is currently running;
// false if one already is, so the caller can skip this cycle instead of
// racing it. With Redis the mark is shared by every instance.
export async function tryStartTick(callId: string): Promise<boolean> {
  if (redisEnabled()) {
    return (await getRedis().set(`call-tick-lock:${callId}`, "1", "PX", TICK_LOCK_MS, "NX")) === "OK";
  }
  if (ticksInProgress.has(callId)) return false;
  ticksInProgress.add(callId);
  return true;
}

// Never throws — it runs in runBillingTick's finally, where a throw would
// replace the tick's real result. A lock that couldn't be deleted expires.
export async function clearTickInProgress(callId: string): Promise<void> {
  if (redisEnabled()) {
    await getRedis()
      .del(`call-tick-lock:${callId}`)
      .catch((err) => logger.error({ err, callId }, "Could not release a billing-tick lock"));
    return;
  }
  ticksInProgress.delete(callId);
}

// With Redis only (returns null otherwise): processes the call-timers queue.
// Every instance runs one; BullMQ hands each job to exactly one of them.
export function startCallTimerWorker(handlers: {
  onTick: (callId: string) => Promise<unknown>;
  onRingingTimeout: (callId: string) => Promise<unknown>;
}): Worker | null {
  if (!redisEnabled()) return null;

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name === "ring") {
        await handlers.onRingingTimeout(job.data.callId);
        return;
      }
      const tick = job.data as TickJob;
      try {
        await handlers.onTick(tick.callId);
      } finally {
        // The next tick is due one interval after this one was due (not after
        // it finished), so billing doesn't drift. If the worker fell a whole
        // interval behind (e.g. no instance was running), it restarts from now
        // instead of firing a burst of catch-up ticks — setInterval doesn't
        // catch up either. It's scheduled even if this tick failed — exactly
        // like setInterval keeps firing — and only while the call is ongoing.
        const [call] = await db.select({ status: calls.status }).from(calls).where(eq(calls.id, tick.callId)).limit(1);
        if (call?.status === "ongoing") {
          const nextDueAt = tick.dueAt + tick.intervalMs;
          await addTickJob({ ...tick, dueAt: nextDueAt > Date.now() ? nextDueAt : Date.now() + tick.intervalMs });
        }
      }
    },
    { connection: newRedisConnection(), concurrency: 50 },
  );
  // A failed job is loud. If the chain itself breaks (e.g. the database is
  // unreachable when scheduling the next tick), callReaper.ts ends the call.
  worker.on("failed", (job, err) => logger.error({ err, job: job?.name, data: job?.data }, "Call timer job failed"));
  return worker;
}

export async function closeCallTimerQueue(): Promise<void> {
  await queue?.close();
}

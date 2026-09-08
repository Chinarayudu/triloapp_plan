import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { logger } from "../../lib/logger";
import { emitToUser } from "../../realtime/socket";
import { checkCollusionSafely, RINGING_TIMEOUT_MS, TICK_INTERVAL_MS } from "./calls.service";
import { clearRingingTimeout, stopBillingInterval } from "./callTimers";

// BACKEND_PLAN.md §8 "Mid-call failure": billing-interval/ringing-timeout
// state lives in-memory (callTimers.ts, single-instance-only by design) —
// a process restart loses every one of those timers, and an "ongoing" call
// left with no live timer would otherwise bill forever (never — it just
// sits there, stuck, until someone notices). This sweep is the backstop:
// it never trusts in-memory timer state, only the DB row's own staleness,
// so it recovers correctly whether the timer died from a restart, a crash,
// or (in principle) an uncaught exception that somehow escaped
// runBillingTick's own try/finally.
//
// Thresholds are generous multiples of the real timeouts, not tight — this
// must never race a call that's simply mid-tick under normal load.
const STALE_RINGING_MS = RINGING_TIMEOUT_MS + 10_000;
const STALE_ONGOING_MS = TICK_INTERVAL_MS * 3;

export async function reapStaleCalls(): Promise<{ reapedRinging: number; reapedOngoing: number }> {
  const now = Date.now();

  const staleRinging = await db
    .select()
    .from(calls)
    .where(and(eq(calls.status, "ringing"), lt(calls.createdAt, new Date(now - STALE_RINGING_MS))));

  for (const call of staleRinging) {
    clearRingingTimeout(call.id);
    const [updated] = await db
      .update(calls)
      .set({ status: "missed", endedAt: new Date(), endReason: "reaped_stale_ringing", updatedAt: new Date() })
      .where(eq(calls.id, call.id))
      .returning();
    emitToUser(updated.userId, "call:ended", { callId: updated.id, status: "missed", totalAmountPaise: 0, totalBeans: 0 });
    logger.warn({ callId: call.id }, "Reaped a stale ringing call (no ring-timeout timer ever fired for it)");
  }

  const staleOngoing = await db
    .select()
    .from(calls)
    .where(and(eq(calls.status, "ongoing"), lt(calls.updatedAt, new Date(now - STALE_ONGOING_MS))));

  for (const call of staleOngoing) {
    stopBillingInterval(call.id);
    const [updated] = await db
      .update(calls)
      .set({ status: "completed", endedAt: new Date(), endReason: "reaped_stale_ongoing", updatedAt: new Date() })
      .where(eq(calls.id, call.id))
      .returning();
    await checkCollusionSafely(call.hostId, call.userId);

    const summary = {
      callId: updated.id,
      status: updated.status,
      totalAmountPaise: updated.totalAmountPaise,
      totalBeans: updated.totalBeans,
      endReason: updated.endReason,
    };
    emitToUser(updated.userId, "call:ended", summary);
    emitToUser(updated.hostId, "call:ended", summary);
    logger.warn({ callId: call.id }, "Reaped a stale ongoing call — its billing tick appears to have stopped without ending the call");
  }

  return { reapedRinging: staleRinging.length, reapedOngoing: staleOngoing.length };
}

// .unref() so this sweep never keeps the process alive by itself — same
// convention as callTimers.ts's per-call timers.
export function startCallReaper(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    void reapStaleCalls().catch((err) => logger.error({ err }, "Call reaper sweep failed"));
  }, intervalMs).unref();
}

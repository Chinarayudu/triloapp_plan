import { eq } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { callBillingTicks, calls } from "../../db/schema";
import { generateAgoraToken } from "../../lib/agoraToken";
import { AppError } from "../../lib/errors";
import { emitToUser } from "../../realtime/socket";
import { getHostProfile, getUserById } from "../users/users.service";
import {
  getCurrentCommissionBasisPoints,
  getCurrentPaisePerBean,
  getUserWalletBalance,
  transferUserToHost,
} from "../wallet/wallet.service";
import { isOnline } from "../hosts/presence.store";
import {
  clearRingingTimeout,
  clearTickInProgress,
  scheduleRingingTimeout,
  startBillingInterval,
  stopBillingInterval,
  tryStartTick,
} from "./callTimers";

// Fixed business constant, not an ops knob — this is "how much time a
// tick bills for," which must stay in lockstep with the math below
// regardless of environment. How often the real scheduler actually fires
// (env.CALL_SCHEDULER_INTERVAL_MS, used only in acceptCall) is the
// separate, legitimately-configurable concern.
export const TICK_INTERVAL_MS = 10_000;
export const RINGING_TIMEOUT_MS = env.CALL_RINGING_TIMEOUT_MS;
const MIN_BUFFER_MINUTES = 1;

type CallRow = typeof calls.$inferSelect;
const ACTIVE_STATUSES: CallRow["status"][] = ["ringing", "ongoing"];

export async function getCallById(callId: string): Promise<CallRow | undefined> {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  return call;
}

async function getActiveCallForUser(userId: string): Promise<CallRow | undefined> {
  const rows = await db.select().from(calls).where(eq(calls.userId, userId));
  return rows.find((c) => ACTIVE_STATUSES.includes(c.status));
}

async function getActiveCallForHost(hostId: string): Promise<CallRow | undefined> {
  const rows = await db.select().from(calls).where(eq(calls.hostId, hostId));
  return rows.find((c) => ACTIVE_STATUSES.includes(c.status));
}

function channelNameFor(callId: string): string {
  return `call-${callId}`;
}

export async function initiateCall(
  userId: string,
  hostId: string,
): Promise<{ call: CallRow; channelName: string; agoraToken: string }> {
  const host = await getUserById(hostId);
  if (!host || host.role !== "host" || host.status !== "active") {
    throw new AppError(404, "Host not found");
  }

  const hostProfile = await getHostProfile(hostId);
  if (!hostProfile?.ratePerMinutePaise) {
    throw new AppError(400, "Host hasn't set a per-minute rate yet");
  }

  if (!isOnline(hostId)) {
    throw new AppError(409, "Host is not online");
  }
  if (await getActiveCallForHost(hostId)) {
    throw new AppError(409, "Host is busy");
  }
  if (await getActiveCallForUser(userId)) {
    throw new AppError(409, "You already have an active call");
  }

  const requiredBalance = hostProfile.ratePerMinutePaise * MIN_BUFFER_MINUTES;
  const balance = await getUserWalletBalance(userId);
  if (balance < requiredBalance) {
    throw new AppError(402, "Insufficient balance to start a call");
  }

  const commissionBasisPointsSnapshot = await getCurrentCommissionBasisPoints();
  const paisePerBeanSnapshot = await getCurrentPaisePerBean();

  const [call] = await db
    .insert(calls)
    .values({
      userId,
      hostId,
      status: "ringing",
      ratePerMinutePaiseSnapshot: hostProfile.ratePerMinutePaise,
      commissionBasisPointsSnapshot,
      paisePerBeanSnapshot,
    })
    .returning();

  scheduleRingingTimeout(call.id, () => void expireRinging(call.id), RINGING_TIMEOUT_MS);

  emitToUser(hostId, "call:incoming", {
    callId: call.id,
    userId,
    ratePerMinutePaise: call.ratePerMinutePaiseSnapshot,
  });

  const channelName = channelNameFor(call.id);
  return { call, channelName, agoraToken: generateAgoraToken(channelName, userId) };
}

export async function acceptCall(
  callId: string,
  hostId: string,
): Promise<{ call: CallRow; channelName: string; agoraToken: string }> {
  const call = await getCallById(callId);
  if (!call) throw new AppError(404, "Call not found");
  if (call.hostId !== hostId) throw new AppError(403, "Not your call");
  if (call.status !== "ringing") throw new AppError(409, `Call is ${call.status}, cannot accept`);

  clearRingingTimeout(callId);

  const [updated] = await db
    .update(calls)
    .set({ status: "ongoing", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(calls.id, callId))
    .returning();

  startBillingInterval(callId, () => void runBillingTick(callId), env.CALL_SCHEDULER_INTERVAL_MS);

  const channelName = channelNameFor(callId);
  emitToUser(call.userId, "call:accepted", { callId, channelName });

  return { call: updated, channelName, agoraToken: generateAgoraToken(channelName, hostId) };
}

export async function rejectCall(callId: string, hostId: string): Promise<CallRow> {
  const call = await getCallById(callId);
  if (!call) throw new AppError(404, "Call not found");
  if (call.hostId !== hostId) throw new AppError(403, "Not your call");
  if (call.status !== "ringing") throw new AppError(409, `Call is ${call.status}, cannot reject`);

  clearRingingTimeout(callId);

  const [updated] = await db
    .update(calls)
    .set({ status: "rejected", endedAt: new Date(), endReason: "rejected_by_host", updatedAt: new Date() })
    .where(eq(calls.id, callId))
    .returning();

  emitToUser(call.userId, "call:ended", { callId, status: "rejected", totalAmountPaise: 0, totalBeans: 0 });

  return updated;
}

export async function endCall(callId: string, requesterId: string): Promise<CallRow> {
  const call = await getCallById(callId);
  if (!call) throw new AppError(404, "Call not found");
  if (call.userId !== requesterId && call.hostId !== requesterId) throw new AppError(403, "Not your call");
  if (!ACTIVE_STATUSES.includes(call.status)) throw new AppError(409, `Call already ${call.status}`);

  let updated: CallRow;
  if (call.status === "ringing") {
    clearRingingTimeout(callId);
    [updated] = await db
      .update(calls)
      .set({ status: "missed", endedAt: new Date(), endReason: "cancelled_by_caller", updatedAt: new Date() })
      .where(eq(calls.id, callId))
      .returning();
  } else {
    stopBillingInterval(callId);
    const endReason = requesterId === call.hostId ? "ended_by_host" : "ended_by_user";
    [updated] = await db
      .update(calls)
      .set({ status: "completed", endedAt: new Date(), endReason, updatedAt: new Date() })
      .where(eq(calls.id, callId))
      .returning();
  }

  const summary = { callId, status: updated.status, totalAmountPaise: updated.totalAmountPaise, totalBeans: updated.totalBeans };
  emitToUser(call.userId, "call:ended", summary);
  emitToUser(call.hostId, "call:ended", summary);

  return updated;
}

// The real ringing-timeout timer calls this after RINGING_TIMEOUT_MS;
// tests call it directly instead of waiting on a real 30s timer.
export async function expireRinging(callId: string): Promise<void> {
  const call = await getCallById(callId);
  if (!call || call.status !== "ringing") return; // already accepted/rejected/cancelled

  const [updated] = await db
    .update(calls)
    .set({ status: "missed", endedAt: new Date(), endReason: "no_answer", updatedAt: new Date() })
    .where(eq(calls.id, callId))
    .returning();

  emitToUser(updated.userId, "call:ended", { callId, status: "missed", totalAmountPaise: 0, totalBeans: 0 });
}

async function endCallForInsufficientBalance(call: CallRow): Promise<void> {
  stopBillingInterval(call.id);
  const [updated] = await db
    .update(calls)
    .set({ status: "completed", endedAt: new Date(), endReason: "insufficient_balance", updatedAt: new Date() })
    .where(eq(calls.id, call.id))
    .returning();

  const summary = {
    callId: call.id,
    status: updated.status,
    totalAmountPaise: updated.totalAmountPaise,
    totalBeans: updated.totalBeans,
    endReason: updated.endReason,
  };
  emitToUser(call.userId, "call:ended", summary);
  emitToUser(call.hostId, "call:ended", summary);
}

// The actual scheduled interval calls this every TICK_INTERVAL_MS in
// production; tests call it directly instead of waiting on real timers.
// Server-authoritative and idempotent per tick number — client-reported
// time is never trusted (BACKEND_PLAN.md §1).
export async function runBillingTick(callId: string): Promise<{ billed: boolean }> {
  // If a previous tick for this same call is still mid-transaction (a slow
  // DB round-trip outlasting TICK_INTERVAL_MS is plausible under load —
  // this actually happened once against real Neon latency during testing),
  // the interval firing again must not overlap it: two ticks racing to
  // read/write the same call row produce a duplicate idempotency key, not
  // graceful behavior. Skipping this cycle is the safe degradation; the
  // next one picks up normally.
  if (!tryStartTick(callId)) {
    return { billed: false };
  }

  try {
    return await runBillingTickInner(callId);
  } finally {
    clearTickInProgress(callId);
  }
}

async function runBillingTickInner(callId: string): Promise<{ billed: boolean }> {
  const call = await getCallById(callId);
  if (!call || call.status !== "ongoing") {
    stopBillingInterval(callId);
    return { billed: false };
  }

  const tickSeconds = TICK_INTERVAL_MS / 1000;
  const tickCost = Math.max(1, Math.round((call.ratePerMinutePaiseSnapshot * tickSeconds) / 60));
  const commissionAmount = Math.floor((tickCost * call.commissionBasisPointsSnapshot) / 10_000);
  const netToHost = tickCost - commissionAmount;
  const beans = Math.floor(netToHost / call.paisePerBeanSnapshot);
  const nextTickNumber = call.tickCount + 1;

  // Everything a tick does — debit, credit, both ledger entries, the tick
  // record, and the call's running totals — is one atomic unit: either
  // the whole tick happened or none of it did. Earlier this was two
  // separate transactions (debit, then credit), which left a real gap
  // where a crash between them could debit a user without ever paying
  // the host. transferUserToHost (wallet.service.ts) is the shared
  // primitive that closes that gap, also used by gifts.service.ts.
  let userBalanceAfter: number;
  try {
    userBalanceAfter = await db.transaction(async (tx) => {
      const { userBalanceAfter: newUserBalance } = await transferUserToHost(tx, {
        userId: call.userId,
        hostId: call.hostId,
        amountPaise: tickCost,
        beans,
        referenceType: "call_billing",
        referenceId: callId,
        debitIdempotencyKey: `${callId}:tick:${nextTickNumber}`,
        creditIdempotencyKey: `${callId}:tick:${nextTickNumber}:credit`,
      });

      await tx.insert(callBillingTicks).values({ callId, tickNumber: nextTickNumber, amountPaise: tickCost, beansCredited: beans });
      await tx
        .update(calls)
        .set({
          totalAmountPaise: call.totalAmountPaise + tickCost,
          totalBeans: call.totalBeans + beans,
          tickCount: nextTickNumber,
          updatedAt: new Date(),
        })
        .where(eq(calls.id, callId));

      return newUserBalance;
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 402) {
      await endCallForInsufficientBalance(call);
      return { billed: false };
    }
    throw err;
  }

  if (userBalanceAfter < tickCost) {
    emitToUser(call.userId, "call:low-balance-warning", { callId, remainingPaise: userBalanceAfter });
  }

  return { billed: true };
}

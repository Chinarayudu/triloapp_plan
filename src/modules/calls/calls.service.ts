import { and, desc, eq, or, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { callBillingTicks, calls, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { sendPushNotification } from "../../lib/push";
import { broadcastBusy, emitToUser, isUserConnected } from "../../realtime/socket";
import { areBlocked } from "../moderation/blocks.service";
import { checkCallCollusion } from "../moderation/fraud.service";
import { createNotification } from "../notifications/notifications.service";
import { getUserById } from "../users/users.service";
import { getHostEffectivePrices, notifyIfLevelledUp } from "../hosts/levels";
import { getVipCallDiscountBasisPoints, isVipActive } from "../wallet/vip.service";
import {
  getCurrentCommissionBasisPoints,
  getCurrentPaisePerBean,
  getUserWalletBalance,
  transferUserToHost,
} from "../wallet/wallet.service";
import { isOnline } from "../hosts/presence.store";
import { CallMediaCredentials, getCallMediaCredentials, getCurrentCallMediaProvider } from "./callMedia.service";
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

// Run wherever a call actually reaches "completed" (below, and
// callReaper.ts's stale-ongoing sweep) — never lets a fraud-signal query
// fail the call-ending flow it's riding along on, same reasoning as the
// try/catch around auth.routes.ts's multi-accounting check.
export async function checkCollusionSafely(hostId: string, userId: string): Promise<void> {
  try {
    await checkCallCollusion(hostId, userId);
  } catch (err) {
    logger.error({ err, hostId, userId }, "Call collusion check failed");
  }
}

export async function getCallById(callId: string): Promise<CallRow | undefined> {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  return call;
}

// User app design follow-up's Past Calls screen — this role of "list my
// calls" previously only existed on the host side (earnings.service.ts's
// getHostHistory).
export type CallListFilter = "all" | "video" | "voice" | "missed";

// Call length bands shown next to a finished call (business rule):
// under 4 min = bad, 4–10 min = good, over 10 min = excellent.
const GOOD_CALL_MIN_SECONDS = 4 * 60;
const EXCELLENT_CALL_MIN_SECONDS = 10 * 60;

export type CallDurationQuality = "bad" | "good" | "excellent";

// null for a call that never connected (missed/rejected) or is still going —
// there's no finished length to judge yet.
export function callDurationQuality(call: { startedAt: Date | null; endedAt: Date | null }): CallDurationQuality | null {
  if (!call.startedAt || !call.endedAt) return null;
  const seconds = (call.endedAt.getTime() - call.startedAt.getTime()) / 1000;
  if (seconds > EXCELLENT_CALL_MIN_SECONDS) return "excellent";
  if (seconds >= GOOD_CALL_MIN_SECONDS) return "good";
  return "bad";
}

function callListWhere(ownerColumn: typeof calls.userId | typeof calls.hostId, ownerId: string, filter: CallListFilter) {
  const conditions = [eq(ownerColumn, ownerId)];
  if (filter === "video" || filter === "voice") conditions.push(eq(calls.type, filter));
  if (filter === "missed") conditions.push(eq(calls.status, "missed"));
  return and(...conditions);
}

async function countCalls(where: ReturnType<typeof callListWhere>) {
  const [row] = await db.select({ total: sql<string>`count(*)` }).from(calls).where(where);
  return Number(row?.total ?? 0);
}

// Past Calls screen (User app). Paged in the database, newest first; the
// response shape predates filters and is kept as-is for the User app.
export async function listCallsForUser(userId: string, filter: CallListFilter, page: number, pageSize: number) {
  const where = callListWhere(calls.userId, userId, filter);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(calls)
      .where(where)
      .orderBy(desc(calls.createdAt), desc(calls.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    countCalls(where),
  ]);
  return {
    calls: rows.map((c) => ({ ...c, durationQuality: callDurationQuality(c) })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

// Calls screen (Host app). summary covers every call matching the filter,
// not just this page, so the screen's totals don't change as pages load.
// earnedPaise is the host's share (beans, after commission) at the current
// rate — the same basis as the dashboard and daily report.
export async function listCallsForHost(hostId: string, filter: CallListFilter, page: number, pageSize: number) {
  const where = callListWhere(calls.hostId, hostId, filter);
  const [rows, total, [sums], paisePerBean] = await Promise.all([
    db
      .select({
        id: calls.id,
        type: calls.type,
        status: calls.status,
        userId: calls.userId,
        callerName: users.name,
        ratePerMinutePaiseSnapshot: calls.ratePerMinutePaiseSnapshot,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        endReason: calls.endReason,
        totalAmountPaise: calls.totalAmountPaise,
        totalBeans: calls.totalBeans,
        createdAt: calls.createdAt,
      })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .where(where)
      .orderBy(desc(calls.createdAt), desc(calls.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    countCalls(where),
    db.select({ beans: sql<string>`coalesce(sum(${calls.totalBeans}), 0)` }).from(calls).where(where),
    getCurrentPaisePerBean(),
  ]);

  const items = rows.map((c) => ({
    ...c,
    callerName: c.callerName ?? "Unknown",
    durationSeconds: c.startedAt && c.endedAt ? Math.floor((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : 0,
    earnedPaise: c.totalBeans * paisePerBean,
    durationQuality: callDurationQuality(c),
  }));
  return {
    calls: items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    summary: { totalCalls: total, earnedPaise: Number(sums?.beans ?? 0) * paisePerBean },
  };
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

// Same user -> name join used by /me/dashboard's recentCalls[].counterpartName
// and /chat/conversations[].otherParticipant.name — calls were the one place
// it had been left out, leaving every incoming-call/active-call/summary
// screen showing a literal "Caller" instead of a name.
export async function getCallParticipantNames(
  userId: string,
  hostId: string,
): Promise<{ callerName: string; hostName: string }> {
  const [caller, host] = await Promise.all([getUserById(userId), getUserById(hostId)]);
  return { callerName: caller?.name ?? "Unknown", hostName: host?.name ?? "Unknown" };
}

export async function initiateCall(
  userId: string,
  hostId: string,
  type: CallRow["type"] = "video",
): Promise<{ call: CallRow; channelName: string; hostName: string } & CallMediaCredentials> {
  const host = await getUserById(hostId);
  if (!host || host.role !== "host" || host.status !== "active") {
    throw new AppError(404, "Host not found");
  }

  if (await areBlocked(userId, hostId)) {
    throw new AppError(403, "This call cannot be connected");
  }

  // Host level sets the price (hosts/levels.ts) — the host's own rate, capped
  // at their level's maximum, or the level price if they haven't set one.
  // Snapshotted onto the call below, so a level-up mid-call doesn't reprice it.
  const prices = await getHostEffectivePrices(hostId);
  const baseRatePerMinutePaise = type === "voice" ? prices.voiceRatePerMinutePaise : prices.videoRatePerMinutePaise;

  // VIP Rate benefit (User app design follow-up) — the discount reduces the
  // price charged to the user, and everything downstream (commission, host
  // beans) is computed from that same discounted amount via the unchanged
  // commission math below: no separate "platform eats the discount" ledger
  // entry, since no economics beyond "discount on all calls" is specified
  // anywhere. Same simple "one conditional, one multiplication" treatment
  // as every other money-path calculation in this function.
  const ratePerMinutePaise = (await isVipActive(userId))
    ? Math.round((baseRatePerMinutePaise * (10_000 - (await getVipCallDiscountBasisPoints()))) / 10_000)
    : baseRatePerMinutePaise;

  if (!isOnline(hostId)) {
    throw new AppError(409, "Host is not online");
  }
  if (await getActiveCallForHost(hostId)) {
    throw new AppError(409, "Host is busy");
  }
  if (await getActiveCallForUser(userId)) {
    throw new AppError(409, "You already have an active call");
  }

  const requiredBalance = ratePerMinutePaise * MIN_BUFFER_MINUTES;
  const balance = await getUserWalletBalance(userId);
  if (balance < requiredBalance) {
    throw new AppError(402, "Insufficient balance to start a call");
  }

  const commissionBasisPointsSnapshot = await getCurrentCommissionBasisPoints(hostId); // BR-COM-03: host override wins if active
  const paisePerBeanSnapshot = await getCurrentPaisePerBean();
  const mediaProvider = await getCurrentCallMediaProvider();
  const caller = await getUserById(userId);

  const [call] = await db
    .insert(calls)
    .values({
      userId,
      hostId,
      status: "ringing",
      type,
      ratePerMinutePaiseSnapshot: ratePerMinutePaise,
      commissionBasisPointsSnapshot,
      paisePerBeanSnapshot,
      mediaProvider,
    })
    .returning();

  scheduleRingingTimeout(call.id, () => void expireRinging(call.id), RINGING_TIMEOUT_MS);

  emitToUser(hostId, "call:incoming", {
    callId: call.id,
    userId,
    callerName: caller?.name ?? "Unknown",
    ratePerMinutePaise: call.ratePerMinutePaiseSnapshot,
    type: call.type,
    mediaProvider: call.mediaProvider,
  });
  // "Online" (presence.store.ts) means the host toggled availability, not
  // that their socket is live right now (BR-NOTIF-01) — a host who went
  // online and then backgrounded/closed the app needs the ring to reach
  // them some other way, same fallback pattern as chat/gift-request.
  if (!(await isUserConnected(hostId))) {
    void sendPushNotification(hostId, "Incoming call", "You have an incoming call");
  }

  const channelName = channelNameFor(call.id);
  const media = await getCallMediaCredentials(call.mediaProvider, channelName, userId);
  return { call, channelName, hostName: host.name ?? "Unknown", ...media };
}

export async function acceptCall(
  callId: string,
  hostId: string,
): Promise<{ call: CallRow; channelName: string; callerName: string } & CallMediaCredentials> {
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
  broadcastBusy(hostId, true);

  const caller = await getUserById(call.userId);
  const media = await getCallMediaCredentials(updated.mediaProvider, channelName, hostId);
  return { call: updated, channelName, callerName: caller?.name ?? "Unknown", ...media };
}

// "p2p" calls only: the two apps exchange WebRTC connection setup (hello /
// offer / answer / ICE candidates) through here — the server never looks
// inside the payload, it just checks the sender is in this call and forwards
// it to the other participant as call:signal. Allowed while ringing too, so
// neither side's first message is refused in the instant around accept.
export async function relayCallSignal(callId: string, senderId: string, data: unknown): Promise<void> {
  const call = await getCallById(callId);
  if (!call) throw new AppError(404, "Call not found");
  if (call.userId !== senderId && call.hostId !== senderId) throw new AppError(403, "Not your call");
  if (call.mediaProvider !== "p2p") throw new AppError(409, "This call doesn't use p2p media");
  if (!ACTIVE_STATUSES.includes(call.status)) throw new AppError(409, `Call already ${call.status}`);

  const recipientId = senderId === call.userId ? call.hostId : call.userId;
  emitToUser(recipientId, "call:signal", { callId, fromUserId: senderId, data });
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
    const caller = await getUserById(call.userId);
    await createNotification(call.hostId, "call_missed", "Missed call", `You missed a call from ${caller?.name ?? "a user"}`);
  } else {
    stopBillingInterval(callId);
    const endReason = requesterId === call.hostId ? "ended_by_host" : "ended_by_user";
    [updated] = await db
      .update(calls)
      .set({ status: "completed", endedAt: new Date(), endReason, updatedAt: new Date() })
      .where(eq(calls.id, callId))
      .returning();
    broadcastBusy(call.hostId, false);
    await checkCollusionSafely(call.hostId, call.userId);
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

  const summary = { callId, status: "missed" as const, totalAmountPaise: 0, totalBeans: 0 };
  emitToUser(updated.userId, "call:ended", summary);
  // Without this, the host's incoming-call screen never learns the ring
  // timed out — it has no event to react to and is stuck showing the call
  // as still incoming.
  emitToUser(updated.hostId, "call:ended", summary);
  await createNotification(updated.hostId, "call_missed", "Missed call", `You missed a call from ${(await getUserById(updated.userId))?.name ?? "a user"}`);
}

async function endCallForInsufficientBalance(call: CallRow): Promise<void> {
  stopBillingInterval(call.id);
  const [updated] = await db
    .update(calls)
    .set({ status: "completed", endedAt: new Date(), endReason: "insufficient_balance", updatedAt: new Date() })
    .where(eq(calls.id, call.id))
    .returning();
  broadcastBusy(call.hostId, false);
  await checkCollusionSafely(call.hostId, call.userId);

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

// A party's app was killed or lost its network mid-call and never came back
// (realtime/socket.ts's checkAbandonedCall). Billing is server-side and keeps
// ticking on its own, so without this the call stayed "ongoing" — host stuck
// busy, user charged every tick — until the user's balance ran out.
export async function endCallForLostConnection(accountId: string): Promise<CallRow | null> {
  const [call] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.status, "ongoing"), or(eq(calls.userId, accountId), eq(calls.hostId, accountId))))
    .limit(1);
  if (!call) return null;

  stopBillingInterval(call.id);
  // Guarded on status so a hang-up landing at the same moment wins cleanly
  // instead of the call being ended twice.
  const [updated] = await db
    .update(calls)
    .set({ status: "completed", endedAt: new Date(), endReason: "connection_lost", updatedAt: new Date() })
    .where(and(eq(calls.id, call.id), eq(calls.status, "ongoing")))
    .returning();
  if (!updated) return null;

  broadcastBusy(call.hostId, false);
  await checkCollusionSafely(call.hostId, call.userId);

  const summary = {
    callId: call.id,
    status: updated.status,
    totalAmountPaise: updated.totalAmountPaise,
    totalBeans: updated.totalBeans,
    endReason: updated.endReason,
  };
  emitToUser(call.userId, "call:ended", summary);
  emitToUser(call.hostId, "call:ended", summary);
  return updated;
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
  let transfer: Awaited<ReturnType<typeof transferUserToHost>>;
  try {
    transfer = await db.transaction(async (tx) => {
      const result = await transferUserToHost(tx, {
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

      return result;
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 402) {
      await endCallForInsufficientBalance(call);
      return { billed: false };
    }
    throw err;
  }

  notifyIfLevelledUp(call.hostId, transfer.hostLifetimeBeansBefore, transfer.hostLifetimeBeansAfter);
  const userBalanceAfter = transfer.userBalanceAfter;

  if (userBalanceAfter < tickCost) {
    emitToUser(call.userId, "call:low-balance-warning", { callId, remainingPaise: userBalanceAfter });
    // A user mid-call is almost always socket-connected, but a native
    // VoIP-style call UI on mobile can keep the call's media running while
    // the app (and its socket) is backgrounded — same fallback reasoning
    // as the other BR-NOTIF-01 triggers.
    if (!(await isUserConnected(call.userId))) {
      void sendPushNotification(call.userId, "Low balance", "Your balance is running low — recharge to keep this call going");
    }
  }

  return { billed: true };
}

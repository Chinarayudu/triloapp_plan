import { and, count, countDistinct, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { calls, loginEvents, moderationReports } from "../../db/schema";
import { logger } from "../../lib/logger";
import { getUserById } from "../users/users.service";
import { createReport } from "./moderation.service";

// BACKEND_PLAN.md §8 "Fraud" (Phase 11) — these are signals, not
// judgments: every check here files a moderation report for a human to
// review (same conservative posture as Phase 10's capture-event
// escalation), it never auto-suspends. False positives are expected and
// acceptable for a *report*, not for an automated ban.

// ---------------------------------------------------------------------------
// Multi-accounting (a host self-calling from a second account to farm
// earnings, or a banned user re-registering) — flagged when too many
// distinct accounts share the same client-reported device fingerprint.
// ---------------------------------------------------------------------------

const MULTI_ACCOUNT_WINDOW_DAYS = 30;
const MULTI_ACCOUNT_THRESHOLD = 3; // distinct accounts sharing one device

export async function recordLoginAndCheckMultiAccounting(
  userId: string,
  deviceFingerprint?: string,
): Promise<void> {
  // No fingerprint from this client — nothing to correlate. Not every
  // frontend build sends one yet, same rollout reality as FLAG_SECURE.
  if (!deviceFingerprint) {
    await db.insert(loginEvents).values({ userId, deviceFingerprint });
    return;
  }

  // Whether this account has ever used this fingerprint before, checked
  // BEFORE inserting this login — the distinct-account count below only
  // needs re-checking the moment a genuinely new account starts sharing
  // the device, not on every repeat login from an account already
  // counted (that can't move the distinct count, so re-checking would
  // just refile the same report forever — checking distinctAccounts ===
  // threshold alone doesn't distinguish "just crossed" from "crossed a
  // while ago and stayed there").
  const [previousLogin] = await db
    .select({ id: loginEvents.id })
    .from(loginEvents)
    .where(and(eq(loginEvents.userId, userId), eq(loginEvents.deviceFingerprint, deviceFingerprint)))
    .limit(1);

  await db.insert(loginEvents).values({ userId, deviceFingerprint });

  if (previousLogin) return;

  const windowStart = new Date(Date.now() - MULTI_ACCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [{ value: distinctAccounts }] = await db
    .select({ value: countDistinct(loginEvents.userId) })
    .from(loginEvents)
    .where(and(eq(loginEvents.deviceFingerprint, deviceFingerprint), gte(loginEvents.createdAt, windowStart)));

  // Fires exactly once, at the login that first pushes the count to the
  // threshold — a later account crossing further past it (4th, 5th, ...)
  // isn't re-flagged, same one-shot-per-signal posture as Phase 10's
  // capture-event escalation.
  if (distinctAccounts === MULTI_ACCOUNT_THRESHOLD) {
    const user = await getUserById(userId);
    await createReport(
      userId,
      user?.role === "host" ? "host" : "user",
      userId,
      `Automated: this device has been used to log into ${distinctAccounts} different accounts in the last ${MULTI_ACCOUNT_WINDOW_DAYS} days`,
    );
    logger.warn({ userId, deviceFingerprint, distinctAccounts }, "Multi-accounting signal — filed for review");
  }
}

// ---------------------------------------------------------------------------
// Self-dealing / collusion (a user and host running up call minutes
// exclusively with each other, e.g. a host paying a friend's account back
// through billing to launder the platform's commission cut, or splitting
// proceeds from an inflated call volume).
// ---------------------------------------------------------------------------

const COLLUSION_MIN_COMPLETED_CALLS = 5; // don't judge off a handful of calls
const COLLUSION_DOMINANT_FRACTION = 0.8; // 80%+ of a host's calls with one user

export async function checkCallCollusion(hostId: string, userId: string): Promise<void> {
  const [{ totalCompleted }] = await db
    .select({ totalCompleted: count() })
    .from(calls)
    .where(and(eq(calls.hostId, hostId), eq(calls.status, "completed")));

  if (totalCompleted < COLLUSION_MIN_COMPLETED_CALLS) return;

  const [{ withThisUser }] = await db
    .select({ withThisUser: count() })
    .from(calls)
    .where(and(eq(calls.hostId, hostId), eq(calls.userId, userId), eq(calls.status, "completed")));

  if (withThisUser / totalCompleted < COLLUSION_DOMINANT_FRACTION) return;

  // Dedupe against an already-open report for the same signal, same
  // reasoning as Phase 10's capture-event escalation — don't refile every
  // single call while a human is already looking at this host.
  const [existing] = await db
    .select({ id: moderationReports.id })
    .from(moderationReports)
    .where(
      and(
        eq(moderationReports.targetType, "host"),
        eq(moderationReports.targetId, hostId),
        eq(moderationReports.status, "pending"),
        sql`${moderationReports.reason} like 'Automated: possible self-dealing%'`,
      ),
    )
    .limit(1);
  if (existing) return;

  await createReport(
    hostId,
    "host",
    hostId,
    `Automated: possible self-dealing — ${withThisUser} of this host's ${totalCompleted} completed calls are with the same user account`,
  );
  logger.warn({ hostId, userId, withThisUser, totalCompleted }, "Call collusion signal — filed for review");
}

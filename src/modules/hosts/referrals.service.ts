import { randomInt } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema";

// Refer & earn (Host app) — tracking only: a host shares their code, and a new
// host account created with it (POST /host/auth/otp/verify { referralCode })
// records who referred it. There is no referral payout yet (the business
// hasn't defined one), so earnedForYouPaise is always 0 and "agents" — a
// concept that doesn't exist in this system — is always empty.

// No 0/O/1/I — codes get read aloud and typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// Generated the first time it's asked for (GET /me), so every existing host
// gets one without a backfill. The unique constraint settles the rare clash.
export async function getOrCreateReferralCode(userId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const [row] = await db
        .update(users)
        .set({ referralCode: code })
        .where(eq(users.id, userId))
        .returning({ referralCode: users.referralCode });
      return row.referralCode!;
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code !== "23505") throw err; // only retry a duplicate code
    }
  }
  throw new Error(`Could not generate a unique referral code for ${userId}`);
}

// The referring host for a code typed at signup, or undefined if it isn't an
// active host's code. Case-insensitive — people type codes however they like.
export async function findReferrerByCode(code: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.referralCode, code.trim().toUpperCase()), eq(users.role, "host"), eq(users.status, "active")))
    .limit(1);
  return row;
}

export async function listReferrals(referrerId: string, type: "streamers" | "agents") {
  if (type === "agents") return [];
  const rows = await db
    .select({ id: users.id, name: users.name, joinedAt: users.createdAt })
    .from(users)
    .where(and(eq(users.referredByUserId, referrerId), eq(users.role, "host")))
    .orderBy(desc(users.createdAt));
  return rows.map((r) => ({ ...r, earnedForYouPaise: 0 }));
}

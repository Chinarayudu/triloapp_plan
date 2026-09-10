import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, hostWallets, notificationPreferences, users, wallets } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { disconnectUser } from "../../realtime/socket";
import { revokeAllRefreshTokensForUser } from "../auth/token.service";

export type SignupRole = "user" | "host";

export async function findUserByPhone(phone: string) {
  const [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  return user;
}

// Admin/sub-admin login only (email+password, Phase 9 follow-up) — Users
// and Hosts never look themselves up by email, only phone.
export async function findUserByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function getUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

// Every account gets its wallet row at signup — the wallet/ledger code
// (wallet.service.ts) trusts that row exists rather than lazily
// creating it, so there's exactly one place a wallet can come into being.
export async function createUser(phone: string, role: SignupRole) {
  const [user] = await db.insert(users).values({ phone, role }).returning();
  if (role === "host") {
    await db.insert(hostProfiles).values({ userId: user.id });
    await db.insert(hostWallets).values({ hostId: user.id });
  } else {
    await db.insert(wallets).values({ userId: user.id });
  }
  await db.insert(notificationPreferences).values({ userId: user.id });
  return user;
}

export async function getHostProfile(userId: string) {
  const [profile] = await db.select().from(hostProfiles).where(eq(hostProfiles.userId, userId)).limit(1);
  return profile;
}

const MIN_AGE_YEARS = 18;

function isAtLeastAge(dob: string, minAgeYears: number): boolean {
  const birthDate = new Date(dob);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - minAgeYears);
  return birthDate <= cutoff;
}

// Self-declared age verification for Users (User app design follow-up) —
// see users.routes.ts's POST /me/verify-age and BRD.md's amendment note on
// BR-ACC-04. Never suspends the account on failure — just leaves
// ageVerified false, nothing more destructive than that.
export async function verifyOwnAge(userId: string): Promise<{ ageVerified: boolean }> {
  const user = await getUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (!user.dob) throw new AppError(400, "Set your date of birth before verifying age");

  if (!isAtLeastAge(user.dob, MIN_AGE_YEARS)) {
    return { ageVerified: false };
  }

  await db.update(users).set({ ageVerified: true, updatedAt: new Date() }).where(eq(users.id, userId));
  return { ageVerified: true };
}

// Delete Account screen (User app design follow-up) — soft delete via
// anonymization, never an actual row removal: past calls/gifts/ledger
// entries need a valid owner to keep meaning. Reuses the same
// token-revocation/socket-disconnect helpers admin.service.ts's
// setAccountStatus already uses for suspension, since the effect (block
// this account from doing anything else, right now) is identical.
export async function deleteOwnAccount(userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw new AppError(404, "User not found");

  await db
    .update(users)
    .set({
      status: "deleted",
      name: null,
      email: null,
      dob: null,
      username: null,
      phone: `deleted-${randomUUID()}`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  await revokeAllRefreshTokensForUser(userId);
  await disconnectUser(userId);
}

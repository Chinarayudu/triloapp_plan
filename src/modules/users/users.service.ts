import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, hostWallets, users, wallets } from "../../db/schema";

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
  return user;
}

export async function getHostProfile(userId: string) {
  const [profile] = await db.select().from(hostProfiles).where(eq(hostProfiles.userId, userId)).limit(1);
  return profile;
}

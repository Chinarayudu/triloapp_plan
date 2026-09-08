import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostFollows, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { getUserById } from "../users/users.service";

// BR-NOTIF-01's "a followed/favorite host going live" — this is the only
// consumer of the relationship right now (live.service.ts's startBroadcast
// notifies everyone in listFollowerIds), so it's kept deliberately thin.

async function assertHostExists(hostId: string): Promise<void> {
  const host = await getUserById(hostId);
  if (!host || host.role !== "host") throw new AppError(404, "Host not found");
}

// Idempotent — following twice is a no-op, not an error, same convention
// as live.service.ts's joinBroadcast.
export async function followHost(userId: string, hostId: string): Promise<void> {
  if (userId === hostId) throw new AppError(400, "Cannot follow yourself");
  await assertHostExists(hostId);

  const [existing] = await db
    .select({ id: hostFollows.id })
    .from(hostFollows)
    .where(and(eq(hostFollows.userId, userId), eq(hostFollows.hostId, hostId)))
    .limit(1);
  if (existing) return;

  await db.insert(hostFollows).values({ userId, hostId });
}

export async function unfollowHost(userId: string, hostId: string): Promise<void> {
  await db.delete(hostFollows).where(and(eq(hostFollows.userId, userId), eq(hostFollows.hostId, hostId)));
}

export async function listFollowedHosts(userId: string) {
  return db
    .select({ hostId: hostFollows.hostId, name: users.name, followedAt: hostFollows.createdAt })
    .from(hostFollows)
    .innerJoin(users, eq(users.id, hostFollows.hostId))
    .where(eq(hostFollows.userId, userId));
}

// Read by live.service.ts's startBroadcast to notify everyone following
// this host — just the ids, since the caller decides how to notify (socket
// + push, same pattern as everywhere else that fans a real-time event out).
export async function listFollowerIds(hostId: string): Promise<string[]> {
  const rows = await db.select({ userId: hostFollows.userId }).from(hostFollows).where(eq(hostFollows.hostId, hostId));
  return rows.map((r) => r.userId);
}

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { hostOnlineSessions } from "../../db/schema";
import { setOffline, setOnline } from "./presence.store";

// The in-memory presence flag (presence.store.ts) answers "is this host
// callable right now"; host_online_sessions is the durable history behind the
// daily report. Every online/offline transition goes through these two
// functions so the two can never disagree.

export async function markHostOnline(hostId: string): Promise<void> {
  setOnline(hostId);
  const [open] = await db
    .select({ id: hostOnlineSessions.id })
    .from(hostOnlineSessions)
    .where(and(eq(hostOnlineSessions.hostId, hostId), isNull(hostOnlineSessions.endedAt)))
    .limit(1);
  // Toggling online twice without going offline is a no-op, not a second
  // overlapping session.
  if (open) return;
  await db.insert(hostOnlineSessions).values({ hostId });
}

export async function markHostOffline(hostId: string, endedAt: Date = new Date()): Promise<void> {
  setOffline(hostId);
  await closeOpenSessions(hostId, endedAt);
}

export async function closeOpenSessions(hostId: string, endedAt: Date): Promise<void> {
  await db
    .update(hostOnlineSessions)
    .set({ endedAt })
    .where(and(eq(hostOnlineSessions.hostId, hostId), isNull(hostOnlineSessions.endedAt)));
}

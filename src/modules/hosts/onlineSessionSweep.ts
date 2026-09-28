import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { hostOnlineSessions } from "../../db/schema";
import { logger } from "../../lib/logger";
import { broadcastPresence, isUserConnected } from "../../realtime/socket";
import { closeOpenSessions, markHostOffline } from "./onlineSessions.service";
import { isOnline } from "./presence.store";

// A host counts as "seen" while they hold a socket connection — Socket.IO's
// own ping/pong already drops a dead connection (killed app, lost network)
// within ~45s, so no separate app heartbeat is needed. This grace covers a
// host who toggled online over REST but never connected (or lost their
// socket without the disconnect handler getting to close the session).
const UNREACHABLE_GRACE_MS = 60_000;

export async function sweepOnlineSessions(now: Date = new Date()): Promise<void> {
  const open = await db.select().from(hostOnlineSessions).where(isNull(hostOnlineSessions.endedAt));

  for (const session of open) {
    // presence.store.ts is in-memory, so after a restart every host reads as
    // offline here — close at the last moment they were actually seen.
    if (!isOnline(session.hostId)) {
      await closeOpenSessions(session.hostId, session.lastSeenAt);
      continue;
    }

    if (await isUserConnected(session.hostId)) {
      await db
        .update(hostOnlineSessions)
        .set({ lastSeenAt: now })
        .where(and(eq(hostOnlineSessions.id, session.id), isNull(hostOnlineSessions.endedAt)));
      continue;
    }

    if (now.getTime() - session.lastSeenAt.getTime() > UNREACHABLE_GRACE_MS) {
      await markHostOffline(session.hostId, session.lastSeenAt);
      broadcastPresence(session.hostId, false);
    }
  }
}

export function startOnlineSessionSweep(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    void sweepOnlineSessions().catch((err) => logger.error({ err }, "Online session sweep failed"));
  }, intervalMs).unref();
}

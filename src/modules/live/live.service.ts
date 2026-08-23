import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { liveBroadcasts, liveViewers, users } from "../../db/schema";
import { AppError } from "../../lib/errors";

type LiveBroadcast = typeof liveBroadcasts.$inferSelect;

export function liveRoomName(broadcastId: string): string {
  return `live-${broadcastId}`;
}

export async function getBroadcastById(id: string): Promise<LiveBroadcast | undefined> {
  const [broadcast] = await db.select().from(liveBroadcasts).where(eq(liveBroadcasts.id, id)).limit(1);
  return broadcast;
}

async function getActiveBroadcastForHost(hostId: string): Promise<LiveBroadcast | undefined> {
  const [broadcast] = await db
    .select()
    .from(liveBroadcasts)
    .where(and(eq(liveBroadcasts.hostId, hostId), eq(liveBroadcasts.status, "live")))
    .limit(1);
  return broadcast;
}

export async function startBroadcast(hostId: string): Promise<LiveBroadcast> {
  if (await getActiveBroadcastForHost(hostId)) {
    throw new AppError(409, "You already have a live broadcast running");
  }
  const [broadcast] = await db.insert(liveBroadcasts).values({ hostId }).returning();
  return broadcast;
}

export async function endBroadcast(broadcastId: string, hostId: string): Promise<LiveBroadcast> {
  const broadcast = await getBroadcastById(broadcastId);
  if (!broadcast) throw new AppError(404, "Broadcast not found");
  if (broadcast.hostId !== hostId) throw new AppError(403, "Not your broadcast");
  if (broadcast.status !== "live") throw new AppError(409, "Broadcast already ended");

  const [updated] = await db
    .update(liveBroadcasts)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(liveBroadcasts.id, broadcastId))
    .returning();

  // Close out anyone still marked as watching, same reasoning as a call
  // ending mid-tick — the broadcast being over is the source of truth,
  // not waiting for each viewer to individually call /leave.
  await db
    .update(liveViewers)
    .set({ leftAt: new Date() })
    .where(and(eq(liveViewers.broadcastId, broadcastId), isNull(liveViewers.leftAt)));

  return updated;
}

export async function listLiveBroadcasts() {
  const rows = await db.select().from(liveBroadcasts).where(eq(liveBroadcasts.status, "live"));

  const result = [];
  for (const broadcast of rows) {
    const [host] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, broadcast.hostId))
      .limit(1);
    const viewerCount = await getConcurrentViewerCount(broadcast.id);
    result.push({ ...broadcast, host, viewerCount });
  }
  return result;
}

async function getConcurrentViewerCount(broadcastId: string): Promise<number> {
  const active = await db
    .select()
    .from(liveViewers)
    .where(and(eq(liveViewers.broadcastId, broadcastId), isNull(liveViewers.leftAt)));
  return active.length;
}

async function getActiveViewerRow(broadcastId: string, userId: string) {
  const [row] = await db
    .select()
    .from(liveViewers)
    .where(and(eq(liveViewers.broadcastId, broadcastId), eq(liveViewers.userId, userId), isNull(liveViewers.leftAt)))
    .limit(1);
  return row;
}

export async function isActiveViewer(broadcastId: string, userId: string): Promise<boolean> {
  return Boolean(await getActiveViewerRow(broadcastId, userId));
}

// Idempotent — calling join twice without a leave in between just returns
// the same viewing session instead of inflating the viewer count with a
// duplicate row.
export async function joinBroadcast(broadcastId: string, userId: string): Promise<LiveBroadcast> {
  const broadcast = await getBroadcastById(broadcastId);
  if (!broadcast || broadcast.status !== "live") throw new AppError(404, "Broadcast not found or has ended");

  const existing = await getActiveViewerRow(broadcastId, userId);
  if (!existing) {
    await db.insert(liveViewers).values({ broadcastId, userId });
  }

  const concurrent = await getConcurrentViewerCount(broadcastId);
  if (concurrent > broadcast.peakViewerCount) {
    await db.update(liveBroadcasts).set({ peakViewerCount: concurrent }).where(eq(liveBroadcasts.id, broadcastId));
  }

  return broadcast;
}

export async function leaveBroadcast(broadcastId: string, userId: string): Promise<void> {
  const existing = await getActiveViewerRow(broadcastId, userId);
  if (!existing) return; // already left, or never joined — leave is idempotent
  await db.update(liveViewers).set({ leftAt: new Date() }).where(eq(liveViewers.id, existing.id));
}

// Anyone allowed to chat in a broadcast is either the host or a
// currently-active viewer — someone who hasn't joined (or already left)
// can't post into a room they're not "in."
export async function assertCanChat(broadcastId: string, senderId: string): Promise<LiveBroadcast> {
  const broadcast = await getBroadcastById(broadcastId);
  if (!broadcast || broadcast.status !== "live") throw new AppError(404, "Broadcast not found or has ended");

  if (senderId === broadcast.hostId) return broadcast;
  if (await isActiveViewer(broadcastId, senderId)) return broadcast;

  throw new AppError(403, "Join the broadcast before chatting in it");
}

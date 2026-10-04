import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { liveBroadcasts, liveMediaConfigs, liveViewers } from "../../db/schema";
import { closeAgoraChannel } from "../../lib/agoraChannel";
import { writeAuditLog } from "../../lib/auditLog";
import { createSfuSession, pullTracks, pushTracks, renegotiate, SessionDescription } from "../../lib/cloudflareSfu";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";

export type LiveMediaProvider = (typeof liveBroadcasts.$inferSelect)["mediaProvider"];

export type LiveMediaConfig = { provider: LiveMediaProvider; agoraKickOnEnd: boolean; pauseHiddenVideo: boolean };

// No row at all = Agora with nothing else switched on — how every broadcast
// behaved before this switch existed.
const DEFAULT_CONFIG: LiveMediaConfig = { provider: "agora", agoraKickOnEnd: false, pauseHiddenVideo: false };

export async function getCurrentLiveMediaConfig(): Promise<LiveMediaConfig> {
  const [row] = await db
    .select()
    .from(liveMediaConfigs)
    .where(lte(liveMediaConfigs.effectiveFrom, new Date()))
    .orderBy(desc(liveMediaConfigs.effectiveFrom))
    .limit(1);
  if (!row) return DEFAULT_CONFIG;
  return { provider: row.provider, agoraKickOnEnd: row.agoraKickOnEnd, pauseHiddenVideo: row.pauseHiddenVideo };
}

export async function listLiveMediaConfigs() {
  return db.select().from(liveMediaConfigs).orderBy(desc(liveMediaConfigs.effectiveFrom));
}

// Takes effect for the next broadcast started; live broadcasts keep the
// provider they started with (liveBroadcasts.mediaProvider). pauseHiddenVideo
// and agoraKickOnEnd are read when used, so they apply to running broadcasts too.
export async function setLiveMediaConfig(adminId: string, config: LiveMediaConfig) {
  const previous = await getCurrentLiveMediaConfig();
  // Server clock, not the DB default — same reasoning as setCallMediaConfig.
  const [row] = await db.insert(liveMediaConfigs).values({ ...config, effectiveFrom: new Date() }).returning();
  await writeAuditLog(adminId, "config.live_media.create", "live_media_config", row.id, { previous, new: config });
  return row;
}

// Run wherever a broadcast ends. Never throws — same reasoning as
// closeCallChannelIfEnabled: the broadcast has already ended.
export async function closeLiveChannelIfEnabled(channelName: string, mediaProvider: LiveMediaProvider): Promise<void> {
  if (mediaProvider !== "agora") return;
  try {
    const config = await getCurrentLiveMediaConfig();
    if (!config.agoraKickOnEnd) return;
    await closeAgoraChannel(channelName);
  } catch (err) {
    logger.error({ err, channelName }, "Could not close the Agora channel of an ended broadcast");
  }
}

async function getLiveCloudflareBroadcast(broadcastId: string) {
  const [broadcast] = await db.select().from(liveBroadcasts).where(eq(liveBroadcasts.id, broadcastId)).limit(1);
  if (!broadcast || broadcast.status !== "live") throw new AppError(404, "Broadcast not found or has ended");
  if (broadcast.mediaProvider !== "cloudflare") throw new AppError(409, "This broadcast doesn't use Cloudflare media");
  return broadcast;
}

// Host pushes their camera/mic. A fresh SFU session each time, so a host
// reconnecting just publishes again; the caller tells viewers to re-pull.
export async function publishBroadcastTracks(
  broadcastId: string,
  hostId: string,
  offer: SessionDescription,
  tracks: { mid: string; trackName: string }[],
): Promise<{ sessionId: string; answer: SessionDescription }> {
  const broadcast = await getLiveCloudflareBroadcast(broadcastId);
  if (broadcast.hostId !== hostId) throw new AppError(403, "Not your broadcast");

  const sessionId = await createSfuSession();
  const answer = await pushTracks(sessionId, offer, tracks);
  await db
    .update(liveBroadcasts)
    .set({ sfuSessionId: sessionId, sfuTrackNames: tracks.map((t) => t.trackName) })
    .where(eq(liveBroadcasts.id, broadcastId));
  return { sessionId, answer };
}

async function getActiveViewerRow(broadcastId: string, userId: string) {
  const [row] = await db
    .select()
    .from(liveViewers)
    .where(and(eq(liveViewers.broadcastId, broadcastId), eq(liveViewers.userId, userId), isNull(liveViewers.leftAt)))
    .limit(1);
  if (!row) throw new AppError(403, "Join the broadcast before watching it");
  return row;
}

// Viewer step 1: a new SFU session pulling the host's tracks. The app answers
// the returned offer and sends it to answerViewerSubscription.
export async function subscribeViewer(
  broadcastId: string,
  userId: string,
): Promise<{ sessionId: string; offer: SessionDescription | null }> {
  const broadcast = await getLiveCloudflareBroadcast(broadcastId);
  const viewer = await getActiveViewerRow(broadcastId, userId);
  if (!broadcast.sfuSessionId || !broadcast.sfuTrackNames?.length) {
    // The host's app hasn't finished publishing yet — the app retries.
    throw new AppError(409, "The host's video isn't ready yet");
  }

  const sessionId = await createSfuSession();
  const { offer } = await pullTracks(sessionId, broadcast.sfuSessionId, broadcast.sfuTrackNames);
  await db.update(liveViewers).set({ sfuSessionId: sessionId }).where(eq(liveViewers.id, viewer.id));
  return { sessionId, offer };
}

// Viewer step 2. Only the viewer the session was created for may complete it.
export async function answerViewerSubscription(
  broadcastId: string,
  userId: string,
  sessionId: string,
  answer: SessionDescription,
): Promise<void> {
  await getLiveCloudflareBroadcast(broadcastId);
  const viewer = await getActiveViewerRow(broadcastId, userId);
  if (viewer.sfuSessionId !== sessionId) throw new AppError(403, "Not your viewing session");
  await renegotiate(sessionId, answer);
}

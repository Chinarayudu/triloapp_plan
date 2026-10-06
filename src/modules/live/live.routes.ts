import { Router } from "express";
import { z } from "zod";
import { generateAgoraToken, RtcRole } from "../../lib/agoraToken";
import { AppError } from "../../lib/errors";
import { getIceServers } from "../../lib/iceServers";
import { sendPushNotification } from "../../lib/push";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToRoom, emitToUser, isUserConnected, joinUserToRoom, leaveUserFromRoom } from "../../realtime/socket";
import { listFollowerIds } from "../hosts/follow.service";
import { getUserById } from "../users/users.service";
import {
  assertCanChat,
  countLiveComment,
  endBroadcast,
  getBroadcastById,
  getConcurrentViewerCount,
  joinBroadcast,
  leaveBroadcast,
  listLiveBroadcasts,
  liveRoomName,
  startBroadcast,
} from "./live.service";
import {
  answerViewerSubscription,
  getCurrentLiveMediaConfig,
  LiveMediaProvider,
  publishBroadcastTracks,
  subscribeViewer,
} from "./liveMedia.service";
import { getAppSettings } from "../settings/appSettings.service";

export const liveRouter = Router();

const broadcastIdSchema = z.string().uuid();

// Same reasoning as calls.routes.ts's parseCallId — Express 5 types a
// route param as `string | string[]`, so this validates down to one
// well-formed UUID rather than casting past the type.
function parseBroadcastId(raw: unknown): string {
  const result = broadcastIdSchema.safeParse(raw);
  if (!result.success) throw new AppError(400, "Invalid broadcast id");
  return result.data;
}

// Exactly one of agoraToken / iceServers is set, by the broadcast's
// snapshotted provider — the apps branch on mediaProvider. pauseHiddenVideo
// tells viewer apps to stop receiving video while hidden (admin switch).
async function liveMediaCredentials(
  broadcast: { mediaProvider: LiveMediaProvider },
  channelName: string,
  uid: string,
  role: (typeof RtcRole)[keyof typeof RtcRole],
) {
  const { pauseHiddenVideo } = await getCurrentLiveMediaConfig();
  if (broadcast.mediaProvider === "cloudflare") {
    return { mediaProvider: broadcast.mediaProvider, agoraToken: null, iceServers: await getIceServers(), pauseHiddenVideo };
  }
  return { mediaProvider: broadcast.mediaProvider, agoraToken: generateAgoraToken(channelName, uid, role), iceServers: null, pauseHiddenVideo };
}

// BR-NOTIF-01's "a followed/favorite host going live" — the only consumer
// of hosts/follow.service.ts's follower list.
async function notifyFollowersHostWentLive(hostId: string, broadcastId: string): Promise<void> {
  const followerIds = await listFollowerIds(hostId);
  if (followerIds.length === 0) return;

  const host = await getUserById(hostId);
  const hostName = host?.name ?? "A host you follow";

  for (const followerId of followerIds) {
    emitToUser(followerId, "live:host-went-live", { hostId, broadcastId });
    if (!(await isUserConnected(followerId))) {
      void sendPushNotification(followerId, "Live now", `${hostName} just went live`);
    }
  }
}

// The body is optional — older Host app builds start a broadcast without one.
const startBroadcastSchema = z.object({ title: z.string().trim().max(120).optional() });

liveRouter.post(
  "/live/broadcasts",
  requireAuth,
  requireRole("host"),
  async (req, res, next) => {
    try {
      const body = startBroadcastSchema.safeParse(req.body ?? {});
      if (!body.success) throw new AppError(400, "title must be at most 120 characters");
      const broadcast = await startBroadcast(req.user!.sub, body.data.title || null);
      await notifyFollowersHostWentLive(req.user!.sub, broadcast.id);
      const channelName = liveRoomName(broadcast.id);
      // Viewers join this room via POST /join below; without also joining
      // the host, io.to(channelName).emit(...) (live:chat, gift:received)
      // never reaches the one person actually running the broadcast.
      await joinUserToRoom(req.user!.sub, channelName);
      res.status(201).json({
        broadcastId: broadcast.id,
        status: broadcast.status,
        channelName,
        // Always on, same as 1:1 calls (calls.routes.ts) — 18+ content is
        // prohibited outright, but hosts' faces/voices are still sensitive.
        secureMode: true,
        ...(await liveMediaCredentials(broadcast, channelName, req.user!.sub, RtcRole.PUBLISHER)),
      });
    } catch (err) {
      next(err);
    }
  },
);

liveRouter.post("/live/broadcasts/:id/end", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const broadcastId = parseBroadcastId(req.params.id);
    const broadcast = await endBroadcast(broadcastId, req.user!.sub);
    emitToRoom(liveRoomName(broadcastId), "live:ended", { broadcastId });
    res.json({ broadcastId: broadcast.id, status: broadcast.status, peakViewerCount: broadcast.peakViewerCount });
  } catch (err) {
    next(err);
  }
});

liveRouter.get("/live/broadcasts", requireAuth, async (req, res, next) => {
  try {
    const broadcasts = await listLiveBroadcasts();
    res.json({ broadcasts });
  } catch (err) {
    next(err);
  }
});

liveRouter.post("/live/broadcasts/:id/join", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const broadcastId = parseBroadcastId(req.params.id);
    const broadcast = await joinBroadcast(broadcastId, req.user!.sub);
    const channelName = liveRoomName(broadcastId);
    await joinUserToRoom(req.user!.sub, channelName);
    res.json({
      broadcastId,
      channelName,
      secureMode: true,
      ...(await liveMediaCredentials(broadcast, channelName, req.user!.sub, RtcRole.SUBSCRIBER)),
    });
  } catch (err) {
    next(err);
  }
});

liveRouter.post("/live/broadcasts/:id/leave", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const broadcastId = parseBroadcastId(req.params.id);
    await leaveBroadcast(broadcastId, req.user!.sub);
    await leaveUserFromRoom(req.user!.sub, liveRoomName(broadcastId));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- "cloudflare" broadcasts: WebRTC setup with the SFU, proxied so the SFU
// app secret never leaves this server (lib/cloudflareSfu.ts). ---

const sdpSchema = z.string().min(1).max(50_000);

const publishSchema = z.object({
  sdp: sdpSchema,
  tracks: z
    .array(z.object({ mid: z.string().min(1).max(100), trackName: z.string().min(1).max(200) }))
    .min(1)
    .max(4),
});

// Host: offer for their camera/mic tracks -> SFU's answer. Viewers already
// watching re-pull via `live:media-updated` (a host republishing after a
// reconnect gets a new SFU session).
liveRouter.post(
  "/live/broadcasts/:id/sfu/publish",
  requireAuth,
  requireRole("host"),
  validateBody(publishSchema),
  async (req, res, next) => {
    try {
      const broadcastId = parseBroadcastId(req.params.id);
      const { sdp, tracks } = req.body as z.infer<typeof publishSchema>;
      const { answer } = await publishBroadcastTracks(broadcastId, req.user!.sub, { type: "offer", sdp }, tracks);
      emitToRoom(liveRoomName(broadcastId), "live:media-updated", { broadcastId });
      res.json({ sdp: answer.sdp });
    } catch (err) {
      next(err);
    }
  },
);

// Viewer step 1 (after POST /join): the SFU's offer of the host's tracks.
// 409 while the host's app is still publishing — retry shortly.
liveRouter.post("/live/broadcasts/:id/sfu/subscribe", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    const { sessionId, offer } = await subscribeViewer(parseBroadcastId(req.params.id), req.user!.sub);
    res.json({ sessionId, sdp: offer?.sdp ?? null });
  } catch (err) {
    next(err);
  }
});

const answerSchema = z.object({ sessionId: z.string().min(1).max(200), sdp: sdpSchema });

// Viewer step 2: the app's answer to that offer.
liveRouter.post(
  "/live/broadcasts/:id/sfu/answer",
  requireAuth,
  requireRole("user"),
  validateBody(answerSchema),
  async (req, res, next) => {
    try {
      const { sessionId, sdp } = req.body as z.infer<typeof answerSchema>;
      await answerViewerSubscription(parseBroadcastId(req.params.id), req.user!.sub, sessionId, { type: "answer", sdp });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// 10,000 is only a hard ceiling; the real limit is the admin setting
// (liveCommentMaxLength, 2000 by default), checked in the handler.
const liveChatSchema = z.object({ content: z.string().min(1).max(10_000) });

liveRouter.post(
  "/live/broadcasts/:id/chat",
  requireAuth,
  validateBody(liveChatSchema),
  async (req, res, next) => {
    try {
      const broadcastId = parseBroadcastId(req.params.id);
      await assertCanChat(broadcastId, req.user!.sub);

      const { content } = req.body as z.infer<typeof liveChatSchema>;
      const { liveCommentMaxLength } = await getAppSettings();
      if (content.length > liveCommentMaxLength) {
        throw new AppError(400, `Comments can be at most ${liveCommentMaxLength} characters`);
      }
      await countLiveComment(broadcastId);
      const sender = await getUserById(req.user!.sub);
      const payload = {
        broadcastId,
        senderId: req.user!.sub,
        senderName: sender?.name ?? "Unknown",
        content,
        createdAt: new Date().toISOString(),
      };
      emitToRoom(liveRoomName(broadcastId), "live:chat", payload);

      res.status(201).json(payload);
    } catch (err) {
      next(err);
    }
  },
);

liveRouter.get("/live/broadcasts/:id", requireAuth, async (req, res, next) => {
  try {
    const broadcastId = parseBroadcastId(req.params.id);
    const broadcast = await getBroadcastById(broadcastId);
    if (!broadcast) throw new AppError(404, "Broadcast not found");
    const viewerCount = await getConcurrentViewerCount(broadcastId);
    res.json({ ...broadcast, viewerCount });
  } catch (err) {
    next(err);
  }
});

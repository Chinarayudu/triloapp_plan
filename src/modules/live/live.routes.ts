import { Router } from "express";
import { z } from "zod";
import { generateAgoraToken, RtcRole } from "../../lib/agoraToken";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToRoom, joinUserToRoom, leaveUserFromRoom } from "../../realtime/socket";
import {
  assertCanChat,
  endBroadcast,
  getBroadcastById,
  joinBroadcast,
  leaveBroadcast,
  listLiveBroadcasts,
  liveRoomName,
  startBroadcast,
} from "./live.service";

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

liveRouter.post("/live/broadcasts", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const broadcast = await startBroadcast(req.user!.sub);
    const channelName = liveRoomName(broadcast.id);
    res.status(201).json({
      broadcastId: broadcast.id,
      status: broadcast.status,
      channelName,
      agoraToken: generateAgoraToken(channelName, req.user!.sub, RtcRole.PUBLISHER),
    });
  } catch (err) {
    next(err);
  }
});

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

liveRouter.get("/live/broadcasts", requireAuth, async (_req, res, next) => {
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
    await joinBroadcast(broadcastId, req.user!.sub);
    const channelName = liveRoomName(broadcastId);
    await joinUserToRoom(req.user!.sub, channelName);
    res.json({
      broadcastId,
      channelName,
      agoraToken: generateAgoraToken(channelName, req.user!.sub, RtcRole.SUBSCRIBER),
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

const liveChatSchema = z.object({ content: z.string().min(1).max(2000) });

liveRouter.post(
  "/live/broadcasts/:id/chat",
  requireAuth,
  validateBody(liveChatSchema),
  async (req, res, next) => {
    try {
      const broadcastId = parseBroadcastId(req.params.id);
      await assertCanChat(broadcastId, req.user!.sub);

      const { content } = req.body as z.infer<typeof liveChatSchema>;
      const payload = { broadcastId, senderId: req.user!.sub, content, createdAt: new Date().toISOString() };
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
    res.json(broadcast);
  } catch (err) {
    next(err);
  }
});

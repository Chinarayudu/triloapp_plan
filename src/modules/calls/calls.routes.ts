import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { perUserRateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import {
  acceptCall,
  callDurationQuality,
  endCall,
  fallBackToAgora,
  getCallById,
  getCallParticipantNames,
  initiateCall,
  listCallsForHost,
  listCallsForUser,
  rejectCall,
  relayCallSignal,
} from "./calls.service";
import { submitCallMediaReport } from "./callMediaReports.service";
import { submitRating } from "./ratings.service";

export const callsRouter = Router();

// Bounds runaway call-initiation abuse (spam-ringing a host, or hammering
// the pre-call balance check) — generous enough to never bother a real
// user (BACKEND_PLAN.md §8 "Rate limiting", Phase 11).
const initiateCallLimiter = perUserRateLimit(60_000, 10);

const initiateSchema = z.object({ hostId: z.string().uuid(), type: z.enum(["video", "voice"]).default("video") });
const callIdSchema = z.string().uuid();

// Express 5's param typing is `string | string[]` (path-to-regexp allows
// repeated params) — this route only ever has one `:id`, so validate it
// down to a single well-formed UUID rather than casting past the type.
function parseCallId(raw: unknown): string {
  const result = callIdSchema.safeParse(raw);
  if (!result.success) throw new AppError(400, "Invalid call id");
  return result.data;
}

callsRouter.post(
  "/calls",
  requireAuth,
  requireRole("user"),
  initiateCallLimiter,
  validateBody(initiateSchema),
  async (req, res, next) => {
    try {
      const { hostId, type } = req.body as z.infer<typeof initiateSchema>;
      const { call, channelName, hostName, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed } = await initiateCall(req.user!.sub, hostId, type);
      // secureMode (BACKEND_PLAN.md §5, BR-MOD-03) — always true for 1:1
      // calls, not conditional on the 18+ toggle: this whole platform is
      // treated as sensitive-by-default (BACKEND_PLAN.md §3), unlike a live
      // broadcast where only specifically-flagged content needs it.
      res
        .status(201)
        .json({ callId: call.id, status: call.status, type: call.type, channelName, secureMode: true, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed, hostName });
    } catch (err) {
      next(err);
    }
  },
);

const listCallsQuerySchema = z.object({
  filter: z.enum(["all", "video", "voice", "missed"]).default("all"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
});

// Past Calls screen (User app) and Calls screen (Host app) — each role sees
// the calls it's a party to.
callsRouter.get("/me/calls", requireAuth, requireRole("user", "host"), async (req, res, next) => {
  const parsed = listCallsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { filter, page, pageSize } = parsed.data;
    if (req.user!.role === "host") {
      res.json(await listCallsForHost(req.user!.sub, filter, page, pageSize));
    } else {
      res.json(await listCallsForUser(req.user!.sub, filter, page, pageSize));
    }
  } catch (err) {
    next(err);
  }
});

callsRouter.get("/calls/:id", requireAuth, async (req, res, next) => {
  try {
    const call = await getCallById(parseCallId(req.params.id));
    if (!call) throw new AppError(404, "Call not found");
    if (call.userId !== req.user!.sub && call.hostId !== req.user!.sub) {
      throw new AppError(403, "Not your call");
    }
    const { callerName, hostName } = await getCallParticipantNames(call.userId, call.hostId);
    res.json({ ...call, secureMode: true, callerName, hostName, durationQuality: callDurationQuality(call) });
  } catch (err) {
    next(err);
  }
});

callsRouter.post("/calls/:id/accept", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const { call, channelName, callerName, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed } = await acceptCall(parseCallId(req.params.id), req.user!.sub);
    res.json({ callId: call.id, status: call.status, type: call.type, channelName, secureMode: true, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed, callerName, userId: call.userId });
  } catch (err) {
    next(err);
  }
});

callsRouter.post("/calls/:id/reject", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const call = await rejectCall(parseCallId(req.params.id), req.user!.sub);
    res.json({ callId: call.id, status: call.status });
  } catch (err) {
    next(err);
  }
});

callsRouter.post("/calls/:id/end", requireAuth, async (req, res, next) => {
  try {
    const call = await endCall(parseCallId(req.params.id), req.user!.sub);
    res.json({
      callId: call.id,
      status: call.status,
      endReason: call.endReason,
      totalAmountPaise: call.totalAmountPaise,
      totalBeans: call.totalBeans,
    });
  } catch (err) {
    next(err);
  }
});

// A few dozen messages per call at most (hello, offer/answer, ICE candidates,
// plus an occasional ICE restart) — this only stops a runaway client loop.
const signalLimiter = perUserRateLimit(60_000, 300);

// Standard WebRTC setup messages. Bounded in size so this can't be used to
// push arbitrary payloads through our socket to the other participant.
const signalSchema = z.object({
  data: z.discriminatedUnion("type", [
    z.object({ type: z.literal("hello") }),
    z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().min(1).max(20_000) }),
    z.object({
      type: z.literal("candidate"),
      candidate: z.object({
        candidate: z.string().max(1_000),
        sdpMid: z.string().max(100).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(100).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      }),
    }),
  ]),
});

callsRouter.post("/calls/:id/signal", requireAuth, signalLimiter, validateBody(signalSchema), async (req, res, next) => {
  try {
    const { data } = req.body as z.infer<typeof signalSchema>;
    await relayCallSignal(parseCallId(req.params.id), req.user!.sub, data);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "auto" calls: the app's direct connection failed, move this call to Agora.
// Returns this participant's Agora credentials; the other participant gets
// theirs via `call:media-fallback`.
callsRouter.post("/calls/:id/media-fallback", requireAuth, async (req, res, next) => {
  try {
    const callId = parseCallId(req.params.id);
    const { channelName, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed } = await fallBackToAgora(callId, req.user!.sub);
    res.json({ callId, channelName, mediaProvider, agoraToken, iceServers, agoraFallbackAllowed });
  } catch (err) {
    next(err);
  }
});

const mediaReportSchema = z.object({
  connected: z.boolean(),
  connectMs: z.number().int().min(0).max(600_000).optional(),
  relayed: z.boolean().optional(),
  avgRttMs: z.number().int().min(0).max(60_000).optional(),
  packetLossPercent: z.number().min(0).max(100).optional(),
  avgVideoKbps: z.number().int().min(0).max(100_000).optional(),
});

// Sent once by each app when a call ends — connection-quality numbers for
// the admin p2p-vs-Agora comparison (GET /admin/calls/media-quality).
callsRouter.post("/calls/:id/media-report", requireAuth, validateBody(mediaReportSchema), async (req, res, next) => {
  try {
    await submitCallMediaReport(parseCallId(req.params.id), req.user!.sub, req.body as z.infer<typeof mediaReportSchema>);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const ratingSchema = z.object({ stars: z.number().int().min(1).max(5) });

callsRouter.post("/calls/:id/rating", requireAuth, validateBody(ratingSchema), async (req, res, next) => {
  try {
    const { stars } = req.body as z.infer<typeof ratingSchema>;
    const rating = await submitRating(parseCallId(req.params.id), req.user!.sub, stars);
    res.status(201).json(rating);
  } catch (err) {
    next(err);
  }
});

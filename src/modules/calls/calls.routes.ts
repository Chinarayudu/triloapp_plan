import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { perUserRateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { acceptCall, endCall, getCallById, initiateCall, rejectCall } from "./calls.service";

export const callsRouter = Router();

// Bounds runaway call-initiation abuse (spam-ringing a host, or hammering
// the pre-call balance check) — generous enough to never bother a real
// user (BACKEND_PLAN.md §8 "Rate limiting", Phase 11).
const initiateCallLimiter = perUserRateLimit(60_000, 10);

const initiateSchema = z.object({ hostId: z.string().uuid() });
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
      const { hostId } = req.body as z.infer<typeof initiateSchema>;
      const { call, channelName, agoraToken } = await initiateCall(req.user!.sub, hostId);
      // secureMode (BACKEND_PLAN.md §5, BR-MOD-03) — always true for 1:1
      // calls, not conditional on the 18+ toggle: this whole platform is
      // treated as sensitive-by-default (BACKEND_PLAN.md §3), unlike a live
      // broadcast where only specifically-flagged content needs it.
      res.status(201).json({ callId: call.id, status: call.status, channelName, secureMode: true, agoraToken });
    } catch (err) {
      next(err);
    }
  },
);

callsRouter.get("/calls/:id", requireAuth, async (req, res, next) => {
  try {
    const call = await getCallById(parseCallId(req.params.id));
    if (!call) throw new AppError(404, "Call not found");
    if (call.userId !== req.user!.sub && call.hostId !== req.user!.sub) {
      throw new AppError(403, "Not your call");
    }
    res.json({ ...call, secureMode: true });
  } catch (err) {
    next(err);
  }
});

callsRouter.post("/calls/:id/accept", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const { call, channelName, agoraToken } = await acceptCall(parseCallId(req.params.id), req.user!.sub);
    res.json({ callId: call.id, status: call.status, channelName, secureMode: true, agoraToken });
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

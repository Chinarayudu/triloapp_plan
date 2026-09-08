import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { perUserRateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { createReport, logCaptureEvent } from "./moderation.service";

export const moderationRouter = Router();

// Bounds queue-spam and escalation-spam abuse (BACKEND_PLAN.md §8 "Rate
// limiting", Phase 11) — both endpoints below feed either the admin
// moderation queue or the automated capture-event escalation, so a burst
// of junk reports is more than just noise, it can trigger a false
// escalation.
const reportLimiter = perUserRateLimit(60_000, 20);
const captureEventLimiter = perUserRateLimit(60_000, 20);

const reportSchema = z.object({
  targetType: z.enum(["user", "host", "chat_message", "call", "live_broadcast"]),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

// Any authenticated User or Host can file a report (BR-MOD-04) — the admin
// side of this (the queue, resolving a report, suspending an account as a
// result) lives under /admin/moderation in admin.routes.ts.
moderationRouter.post(
  "/moderation/reports",
  requireAuth,
  reportLimiter,
  validateBody(reportSchema),
  async (req, res, next) => {
    try {
      const { targetType, targetId, reason } = req.body as z.infer<typeof reportSchema>;
      const report = await createReport(req.user!.sub, targetType, targetId, reason);
      res.status(201).json(report);
    } catch (err) {
      next(err);
    }
  },
);

const captureEventSchema = z.object({
  context: z.enum(["call", "chat", "live"]),
  contextId: z.string().uuid().optional(),
});

// BR-MOD-03 — the client calls this the moment it detects a screen
// capture/recording attempt during a sensitive session. Any authenticated
// role can call it (it's reporting on the caller's own session, not
// someone else's), unlike /moderation/reports above.
moderationRouter.post(
  "/moderation/capture-event",
  requireAuth,
  captureEventLimiter,
  validateBody(captureEventSchema),
  async (req, res, next) => {
    try {
      const { context, contextId } = req.body as z.infer<typeof captureEventSchema>;
      const result = await logCaptureEvent(req.user!.sub, context, contextId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

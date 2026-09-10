import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { generateUploadUrl } from "../../lib/s3";
import { requireAuth } from "../../middleware/auth";
import { perUserRateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { blockUser, listBlocked, unblockUser } from "./blocks.service";
import { submitGrievance } from "./grievance.service";
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

// A safety tool distinct from reports above (BRD.md lists "block/report" as
// two separate host safety tools) — blocking mechanically stops calls/chat
// between the pair (calls.service.ts, chat.service.ts), no admin review.
const blockSchema = z.object({ userId: z.string().uuid() });

moderationRouter.post("/moderation/blocks", requireAuth, validateBody(blockSchema), async (req, res, next) => {
  try {
    const { userId } = req.body as z.infer<typeof blockSchema>;
    res.status(201).json(await blockUser(req.user!.sub, userId));
  } catch (err) {
    next(err);
  }
});

moderationRouter.delete("/moderation/blocks/:userId", requireAuth, async (req, res, next) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.userId);
    if (!parsed.success) throw new AppError(400, "Invalid user id");
    await unblockUser(req.user!.sub, parsed.data);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

moderationRouter.get("/moderation/blocks", requireAuth, async (req, res, next) => {
  try {
    res.json({ blocked: await listBlocked(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});

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

// The India IT-Rules-style formal grievance form (User app design
// follow-up) — a slower-SLA, structured complaint distinct from
// /moderation/reports above. Evidence upload reuses the same presign-then-
// submit flow as KYC documents (users.routes.ts).
const grievanceUploadExtensionByContentType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

const grievanceUploadUrlSchema = z.object({
  contentType: z.enum(Object.keys(grievanceUploadExtensionByContentType) as [string, ...string[]]),
});

moderationRouter.post(
  "/grievances/upload-url",
  requireAuth,
  validateBody(grievanceUploadUrlSchema),
  async (req, res, next) => {
    try {
      const { contentType } = req.body as z.infer<typeof grievanceUploadUrlSchema>;
      const extension = grievanceUploadExtensionByContentType[contentType];
      const key = `grievance-evidence/${req.user!.sub}/${randomUUID()}.${extension}`;
      const uploadUrl = await generateUploadUrl(key, contentType);
      res.json({ uploadUrl, key });
    } catch (err) {
      next(err);
    }
  },
);

const grievanceSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  contactNumber: z.string().min(5).max(20),
  email: z.string().email(),
  natureOfComplaint: z.enum([
    "content_objection",
    "nudity_pornography",
    "reinstatement",
    "copyright_violation",
    "judicial_order",
    "government_request",
    "privacy",
    "impersonation",
    "child_safety",
    "other",
  ]),
  description: z.string().min(1).max(5000),
  evidenceKeys: z.array(z.string().min(1)).max(10).default([]),
});

moderationRouter.post("/grievances", requireAuth, validateBody(grievanceSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof grievanceSchema>;
    for (const key of body.evidenceKeys) {
      if (!key.startsWith(`grievance-evidence/${req.user!.sub}/`)) {
        throw new AppError(403, "This evidence file does not belong to your account");
      }
    }

    const grievance = await submitGrievance({ userId: req.user!.sub, ...body });
    res.status(201).json(grievance);
  } catch (err) {
    next(err);
  }
});

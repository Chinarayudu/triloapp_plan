import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client";
import { hostProfiles, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateUploadUrl } from "../../lib/s3";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { addGalleryItem, deleteOwnGalleryItem, listGalleryItems } from "../hosts/gallery.service";
import { createSubmission, getLatestSubmission, getSubmissionDocuments } from "./kyc.service";
import { getHostProfile, getUserById } from "./users.service";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.sub);
    if (!user) throw new AppError(404, "User not found");

    const hostProfile = user.role === "host" ? await getHostProfile(user.id) : undefined;

    res.json({
      id: user.id,
      role: user.role,
      phone: user.phone,
      name: user.name,
      email: user.email,
      dob: user.dob,
      ageVerified: user.ageVerified,
      kycStatus: user.kycStatus,
      status: user.status,
      hostProfile,
    });
  } catch (err) {
    next(err);
  }
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  dob: z.string().date().optional(),
});

usersRouter.patch("/me", requireAuth, validateBody(updateMeSchema), async (req, res, next) => {
  try {
    const updates = req.body as z.infer<typeof updateMeSchema>;
    const [updated] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, req.user!.sub))
      .returning();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const updateHostProfileSchema = z.object({
  bio: z.string().max(500).optional(),
  gallery: z.array(z.string().url()).max(20).optional(),
  ratePerMinutePaise: z.number().int().positive().optional(),
});

usersRouter.patch(
  "/me/host-profile",
  requireAuth,
  requireRole("host"),
  validateBody(updateHostProfileSchema),
  async (req, res, next) => {
    try {
      const updates = req.body as z.infer<typeof updateHostProfileSchema>;
      const [updated] = await db
        .update(hostProfiles)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(hostProfiles.userId, req.user!.sub))
        .returning();
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// Structured gallery items (media type + video duration) — admin design
// follow-up, separate from PATCH /me/host-profile's bulk `gallery` string
// array above (untouched, still works) so admin can view/delete one item
// at a time (admin.routes.ts's GET/DELETE /admin/hosts/:id/gallery).
const addGalleryItemSchema = z.object({
  mediaType: z.enum(["photo", "video"]),
  url: z.string().url(),
  durationSeconds: z.number().int().positive().optional(),
});

usersRouter.post(
  "/me/host-profile/gallery",
  requireAuth,
  requireRole("host"),
  validateBody(addGalleryItemSchema),
  async (req, res, next) => {
    try {
      const { mediaType, url, durationSeconds } = req.body as z.infer<typeof addGalleryItemSchema>;
      res.status(201).json(await addGalleryItem(req.user!.sub, mediaType, url, durationSeconds));
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get("/me/host-profile/gallery", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json({ items: await listGalleryItems(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete("/me/host-profile/gallery/:itemId", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const itemId = z.string().uuid().safeParse(req.params.itemId);
    if (!itemId.success) throw new AppError(400, "Invalid gallery item id");
    await deleteOwnGalleryItem(req.user!.sub, itemId.data);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// KYC documents live in a private S3 bucket (no public access) — the
// three-step flow below is: get a presigned PUT URL, upload directly to
// S3 from the client, then tell us the resulting key so we can record the
// submission. Viewing later (GET /me/kyc) generates a fresh presigned GET
// URL on demand rather than storing one, since those expire.
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

const uploadUrlSchema = z.object({
  contentType: z.enum(Object.keys(EXTENSION_BY_CONTENT_TYPE) as [string, ...string[]]),
});

usersRouter.post("/me/kyc/upload-url", requireAuth, validateBody(uploadUrlSchema), async (req, res, next) => {
  try {
    const { contentType } = req.body as z.infer<typeof uploadUrlSchema>;
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    const key = `kyc/${req.user!.sub}/${randomUUID()}.${extension}`;
    const uploadUrl = await generateUploadUrl(key, contentType);
    res.json({ uploadUrl, key });
  } catch (err) {
    next(err);
  }
});

// Every key must belong to the caller (kyc/{their own user id}/...) —
// without this check, one account could submit KYC using a document key it
// never actually uploaded, just by guessing/copying another user's key.
// 1-4 documents, each a distinct type (front/back/selfie/address proof) —
// a real submission history now, not a single overwritten column; see
// kyc.service.ts's createSubmission.
const kycSchema = z.object({
  documents: z
    .array(
      z.object({
        documentType: z.enum(["id_front", "id_back", "selfie", "address_proof"]),
        key: z.string().min(1),
      }),
    )
    .min(1)
    .max(4)
    .refine(
      (docs) => new Set(docs.map((d) => d.documentType)).size === docs.length,
      "Each document type can only be submitted once per attempt",
    ),
});

usersRouter.post("/me/kyc", requireAuth, validateBody(kycSchema), async (req, res, next) => {
  try {
    const { documents } = req.body as z.infer<typeof kycSchema>;
    for (const doc of documents) {
      if (!doc.key.startsWith(`kyc/${req.user!.sub}/`)) {
        throw new AppError(403, "This document key does not belong to your account");
      }
    }

    const submission = await createSubmission(req.user!.sub, documents);
    res.json({ submissionId: submission.id, attemptNumber: submission.attemptNumber, kycStatus: submission.status });
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/me/kyc", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.sub);
    if (!user) throw new AppError(404, "User not found");

    const submission = await getLatestSubmission(req.user!.sub);
    const documents = submission ? await getSubmissionDocuments(submission.id) : [];
    res.json({
      kycStatus: user.kycStatus,
      attemptNumber: submission?.attemptNumber ?? null,
      rejectionReason: submission?.rejectionReason ?? null,
      documents,
    });
  } catch (err) {
    next(err);
  }
});

// UPI or bank payout details (BR-ACC-03, BACKEND_PLAN.md §1 withdrawals) —
// stored as a JSON string in hostProfiles.payoutDetails, same "structure
// finalized when withdrawals land" placeholder column added back in
// Phase 1. Snapshotted onto each withdrawal request at creation time
// (withdrawal.service.ts) so a host changing their bank details later
// doesn't retroactively alter a request already in flight.
const payoutDetailsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upi"), vpa: z.string().min(3).max(100) }),
  z.object({
    type: z.literal("bank"),
    accountHolderName: z.string().min(1).max(100),
    accountNumber: z.string().min(4).max(30),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC code"),
  }),
]);

usersRouter.patch(
  "/me/payout-details",
  requireAuth,
  requireRole("host"),
  validateBody(payoutDetailsSchema),
  async (req, res, next) => {
    try {
      const payoutDetails = req.body as z.infer<typeof payoutDetailsSchema>;
      const [updated] = await db
        .update(hostProfiles)
        .set({ payoutDetails: JSON.stringify(payoutDetails), updatedAt: new Date() })
        .where(eq(hostProfiles.userId, req.user!.sub))
        .returning();
      res.json({ payoutDetails: JSON.parse(updated.payoutDetails as string) });
    } catch (err) {
      next(err);
    }
  },
);

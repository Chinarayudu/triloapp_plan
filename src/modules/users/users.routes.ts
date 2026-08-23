import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { hostProfiles, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateDownloadUrl, generateUploadUrl } from "../../lib/s3";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
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

// The key must belong to the caller (kyc/{their own user id}/...) — without
// this check, one account could submit KYC using a document key it never
// actually uploaded, just by guessing/copying another user's key.
const kycSchema = z.object({ key: z.string().min(1) });

usersRouter.post("/me/kyc", requireAuth, validateBody(kycSchema), async (req, res, next) => {
  try {
    const { key } = req.body as z.infer<typeof kycSchema>;
    if (!key.startsWith(`kyc/${req.user!.sub}/`)) {
      throw new AppError(403, "This document key does not belong to your account");
    }

    const [updated] = await db
      .update(users)
      .set({ kycDocumentKey: key, kycStatus: "pending", updatedAt: new Date() })
      .where(eq(users.id, req.user!.sub))
      .returning();
    res.json({ kycStatus: updated.kycStatus });
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/me/kyc", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.sub);
    if (!user) throw new AppError(404, "User not found");

    const documentViewUrl = user.kycDocumentKey ? await generateDownloadUrl(user.kycDocumentKey) : null;
    res.json({ kycStatus: user.kycStatus, documentViewUrl });
  } catch (err) {
    next(err);
  }
});

// Stands in for the Phase 9 admin KYC-approval queue — there is no admin
// auth/panel yet to gate real approval behind, so this is a dev-only
// escape hatch (hard-blocked in production) that lets withdrawal's
// KYC-gate (BR-EARN-03) be built and tested for real in the meantime, the
// same way wallet.routes.ts's POST /wallet/dev-credit stands in for a
// payment gateway.
usersRouter.post("/me/kyc/dev-approve", requireAuth, async (req, res, next) => {
  try {
    if (env.NODE_ENV === "production") throw new AppError(403, "Disabled in production");

    const user = await getUserById(req.user!.sub);
    if (!user) throw new AppError(404, "User not found");
    if (!user.kycDocumentKey) throw new AppError(400, "Submit a KYC document first");

    const [updated] = await db
      .update(users)
      .set({ kycStatus: "approved", updatedAt: new Date() })
      .where(eq(users.id, req.user!.sub))
      .returning();
    res.json({ kycStatus: updated.kycStatus });
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

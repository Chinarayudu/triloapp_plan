import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client";
import { BeautySettings, hostProfiles, payoutMethods, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateUploadUrl, getPublicUrl } from "../../lib/s3";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { getHostRatingSummary } from "../calls/ratings.service";
import { addGalleryItem, deleteOwnGalleryItem, listGalleryItems } from "../hosts/gallery.service";
import {
  addPayoutMethod,
  deletePayoutMethod,
  listPayoutMethods,
  setPrimaryPayoutMethod,
} from "../hosts/payoutMethods.service";
import { isVipActive } from "../wallet/vip.service";
import { createSubmission, getLatestSubmission, getSubmissionDocuments } from "./kyc.service";
import { getPreferences, updatePreferences } from "./notificationPreferences.service";
import { deleteOwnAccount, getHostProfile, getUserById, verifyOwnAge } from "./users.service";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.sub);
    if (!user) throw new AppError(404, "User not found");

    const hostProfile =
      user.role === "host"
        ? { ...(await getHostProfile(user.id)), rating: await getHostRatingSummary(user.id) }
        : undefined;

    res.json({
      id: user.id,
      role: user.role,
      phone: user.phone,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      dob: user.dob,
      ageVerified: user.ageVerified,
      languages: user.languages,
      kycStatus: user.kycStatus,
      status: user.status,
      isVipActive: user.role === "user" ? await isVipActive(user.id) : undefined,
      hostProfile,
    });
  } catch (err) {
    next(err);
  }
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
    .optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
  dob: z.string().date().optional(),
  languages: z.array(z.string().min(1)).max(20).optional(),
});

usersRouter.patch("/me", requireAuth, validateBody(updateMeSchema), async (req, res, next) => {
  try {
    const updates = req.body as z.infer<typeof updateMeSchema>;

    if (updates.username) {
      const [existing] = await db.select().from(users).where(eq(users.username, updates.username)).limit(1);
      if (existing && existing.id !== req.user!.sub) throw new AppError(409, "Username is already taken");
    }

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

// Profile photo (User/Host Edit Profile screens, and Host onboarding's
// "Set up profile" step) — same presign-then-PATCH pattern as the gallery
// upload flow below, except the result is a single column on `users`
// (avatarUrl) rather than an appended list, and there's no role restriction
// since both Users and Hosts have a profile photo.
const AVATAR_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

const avatarUploadUrlSchema = z.object({
  contentType: z.enum(Object.keys(AVATAR_EXTENSION_BY_CONTENT_TYPE) as [string, ...string[]]),
});

usersRouter.post(
  "/me/avatar/upload-url",
  requireAuth,
  validateBody(avatarUploadUrlSchema),
  async (req, res, next) => {
    try {
      const { contentType } = req.body as z.infer<typeof avatarUploadUrlSchema>;
      const extension = AVATAR_EXTENSION_BY_CONTENT_TYPE[contentType];
      const key = `avatar/${req.user!.sub}/${randomUUID()}.${extension}`;
      const uploadUrl = await generateUploadUrl(key, contentType);
      res.json({ uploadUrl, key, url: getPublicUrl(key) });
    } catch (err) {
      next(err);
    }
  },
);

// Self-declared age verification for Users (User app design follow-up) —
// a deliberate deviation from BR-ACC-04's "distinct from a self-declared
// checkbox" bar; Hosts keep the KYC-reviewed path unchanged
// (admin.service.ts's decideKyc). See BRD.md's amendment note on BR-ACC-04.
usersRouter.post("/me/verify-age", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    res.json(await verifyOwnAge(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

const deleteAccountSchema = z.object({ confirm: z.literal("DELETE") });

// Never actually deletes the row — past calls/gifts/ledger entries keep a
// valid (now-anonymized) owner. See users.service.ts's deleteOwnAccount.
usersRouter.post("/me/delete-account", requireAuth, validateBody(deleteAccountSchema), async (req, res, next) => {
  try {
    await deleteOwnAccount(req.user!.sub);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const updateHostProfileSchema = z.object({
  bio: z.string().max(500).optional(),
  gallery: z.array(z.string().url()).max(20).optional(),
  ratePerMinutePaise: z.number().int().positive().optional(),
  voiceRatePerMinutePaise: z.number().int().positive().optional(),
  privateLiveRatePerMinutePaise: z.number().int().positive().optional(),
  autoAcceptCalls: z.boolean().optional(),
  voiceCallsOnlyAfterMidnight: z.boolean().optional(),
  // Creator Profile screen's structured sections (User app design follow-up).
  languages: z.array(z.string().min(1)).max(20).optional(),
  talksAboutTags: z.array(z.string().min(1)).max(20).optional(),
  hobbies: z.array(z.string().min(1)).max(20).optional(),
  sports: z.array(z.string().min(1)).max(20).optional(),
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

// Beauty/filter pipeline lives entirely client-side (in-camera Beauty
// screen); this just persists and round-trips the one JSON blob it produces,
// same "save the whole object" shape every time — not a partial merge like
// PATCH /me/host-profile above. preset.id/filterId are intentionally
// z.string() rather than z.enum(...): the client's fixed set of presets and
// filters can grow without a backend change or deploy.
const beautySettingsSchema = z.object({
  enabled: z.boolean(),
  preset: z.object({
    id: z.string().min(1),
    intensity: z.number().int().min(0).max(100),
  }),
  filterId: z.string().min(1),
  custom: z.object({
    exposure: z.number().int().min(-50).max(50),
    brightness: z.number().int().min(-50).max(50),
    contrast: z.number().int().min(-50).max(50),
    saturation: z.number().int().min(-50).max(50),
    temperature: z.number().int().min(-50).max(50),
    tint: z.number().int().min(-50).max(50),
    highlights: z.number().int().min(-50).max(50),
    shadows: z.number().int().min(-50).max(50),
    sharpness: z.number().int().min(-50).max(50),
    vibrance: z.number().int().min(-50).max(50),
  }),
}) satisfies z.ZodType<BeautySettings>;

usersRouter.patch(
  "/me/beauty-settings",
  requireAuth,
  requireRole("host"),
  validateBody(beautySettingsSchema),
  async (req, res, next) => {
    try {
      const beautySettings = req.body as BeautySettings;
      const [updated] = await db
        .update(hostProfiles)
        .set({ beautySettings, updatedAt: new Date() })
        .where(eq(hostProfiles.userId, req.user!.sub))
        .returning({ beautySettings: hostProfiles.beautySettings });
      res.json(updated.beautySettings);
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

// Same presign flow as /me/kyc/upload-url, reusing the same generateUploadUrl
// helper with a gallery/{hostId}/... key prefix so gallery and KYC files
// never share a namespace. Unlike KYC, the resulting url is meant to be
// public (shown on a host's profile), so this also returns the final url
// to submit to POST /me/host-profile/gallery, not just the key.
const GALLERY_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
};

const galleryUploadUrlSchema = z.object({
  contentType: z.enum(Object.keys(GALLERY_EXTENSION_BY_CONTENT_TYPE) as [string, ...string[]]),
});

usersRouter.post(
  "/me/host-profile/gallery/upload-url",
  requireAuth,
  requireRole("host"),
  validateBody(galleryUploadUrlSchema),
  async (req, res, next) => {
    try {
      const { contentType } = req.body as z.infer<typeof galleryUploadUrlSchema>;
      const extension = GALLERY_EXTENSION_BY_CONTENT_TYPE[contentType];
      const key = `gallery/${req.user!.sub}/${randomUUID()}.${extension}`;
      const uploadUrl = await generateUploadUrl(key, contentType);
      res.json({ uploadUrl, key, url: getPublicUrl(key) });
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
  // Selfie liveness capture (Host app) records via the browser's
  // MediaRecorder, which reports contentType as this base type plus a
  // codecs= parameter that varies by browser/OS (e.g. "codecs=vp9,opus" on
  // Chrome/Android, "codecs=vp8,opus" on Firefox) — matched below on the
  // part before the first ";", not the full string, since we don't care
  // which codec combination was used, only that it's still webm.
  "video/webm": "webm",
};

const KYC_CONTENT_TYPES = Object.keys(EXTENSION_BY_CONTENT_TYPE);

const uploadUrlSchema = z.object({
  contentType: z.string().refine((value) => value.split(";")[0].trim() in EXTENSION_BY_CONTENT_TYPE, {
    message: `Invalid option: expected one of ${KYC_CONTENT_TYPES.map((t) => `"${t}"`).join("|")}`,
  }),
});

usersRouter.post("/me/kyc/upload-url", requireAuth, validateBody(uploadUrlSchema), async (req, res, next) => {
  try {
    const { contentType } = req.body as z.infer<typeof uploadUrlSchema>;
    const baseType = contentType.split(";")[0].trim();
    const extension = EXTENSION_BY_CONTENT_TYPE[baseType];
    const key = `kyc/${req.user!.sub}/${randomUUID()}.${extension}`;
    // The full contentType (codecs included) is still what's sent to S3 as
    // the object's Content-Type — that's a legal HTTP media-type parameter,
    // no reason to throw the codec info away just because validation above
    // only needed the base type.
    const uploadUrl = await generateUploadUrl(key, contentType);
    res.json({ uploadUrl, key });
  } catch (err) {
    next(err);
  }
});

// Every key must belong to the caller (kyc/{their own user id}/...) —
// without this check, one account could submit KYC using a document key it
// never actually uploaded, just by guessing/copying another user's key.
// 1-5 documents, each a distinct type (front/back/selfie/address
// proof/audition video) — a real submission history now, not a single
// overwritten column; see kyc.service.ts's createSubmission.
const kycSchema = z.object({
  documents: z
    .array(
      z.object({
        documentType: z.enum(["id_front", "id_back", "selfie", "address_proof", "audition_video"]),
        key: z.string().min(1),
      }),
    )
    .min(1)
    .max(5)
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

// UPI or bank payout methods (BR-ACC-03, BACKEND_PLAN.md §1 withdrawals) —
// a host can hold several (payout_methods table, Host app design
// follow-up: "Add New Payout Account" screen shows a primary bank account
// plus a backup UPI id). Snapshotted onto each withdrawal request at
// creation time (withdrawal.service.ts) so a host changing their details
// later doesn't retroactively alter a request already in flight.
const payoutMethodBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upi"), vpa: z.string().min(3).max(100) }),
  z.object({
    type: z.literal("bank"),
    accountHolderName: z.string().min(1).max(100),
    accountNumber: z.string().min(4).max(30),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC code"),
  }),
]);

function serializePayoutMethod(method: typeof payoutMethods.$inferSelect) {
  return { id: method.id, type: method.type, isPrimary: method.isPrimary, details: JSON.parse(method.detailsJson) };
}

usersRouter.post(
  "/me/payout-methods",
  requireAuth,
  requireRole("host"),
  validateBody(payoutMethodBodySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof payoutMethodBodySchema>;
      const method = await addPayoutMethod(req.user!.sub, body.type, JSON.stringify(body));
      res.status(201).json(serializePayoutMethod(method));
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get("/me/payout-methods", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const methods = await listPayoutMethods(req.user!.sub);
    res.json({ methods: methods.map(serializePayoutMethod) });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete("/me/payout-methods/:id", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid payout method id");
    await deletePayoutMethod(req.user!.sub, id.data);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

usersRouter.patch("/me/payout-methods/:id/primary", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid payout method id");
    const method = await setPrimaryPayoutMethod(req.user!.sub, id.data);
    res.json(serializePayoutMethod(method));
  } catch (err) {
    next(err);
  }
});

// Notification Settings screen (Host app design follow-up) — real,
// persisted CRUD only. Gating actual push sends on these is a follow-up,
// not built here (push.ts is still a dev-log stub with no real provider).
const notificationPreferencesSchema = z.object({
  incomingCalls: z.boolean().optional(),
  missedCalls: z.boolean().optional(),
  newMessages: z.boolean().optional(),
  callReminders: z.boolean().optional(),
  giftsReceived: z.boolean().optional(),
  withdrawalUpdates: z.boolean().optional(),
  weeklyEarningsSummary: z.boolean().optional(),
  promotionsAndTips: z.boolean().optional(),
  liveAlerts: z.boolean().optional(),
  callSummaries: z.boolean().optional(),
  walletActivityAlerts: z.boolean().optional(),
  dndEnabled: z.boolean().optional(),
  dndStartHour: z.number().int().min(0).max(23).optional(),
  dndEndHour: z.number().int().min(0).max(23).optional(),
});

usersRouter.get("/me/notification-preferences", requireAuth, async (req, res, next) => {
  try {
    res.json(await getPreferences(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

usersRouter.patch(
  "/me/notification-preferences",
  requireAuth,
  validateBody(notificationPreferencesSchema),
  async (req, res, next) => {
    try {
      const updates = req.body as z.infer<typeof notificationPreferencesSchema>;
      res.json(await updatePreferences(req.user!.sub, updates));
    } catch (err) {
      next(err);
    }
  },
);

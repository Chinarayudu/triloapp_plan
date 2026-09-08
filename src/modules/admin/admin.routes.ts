import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { writeAuditLog } from "../../lib/auditLog";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToRoom } from "../../realtime/socket";
import {
  decideWithdrawal,
  getWithdrawalById,
  getWithdrawalDetailForAdmin,
  listWithdrawalsByStatus,
} from "../withdrawals/withdrawal.service";
import { reconcileAllWallets } from "../wallet/reconciliation.service";
import { getReportById, listReports, resolveReport, warnAccount } from "../moderation/moderation.service";
import { getAccountDetailForAdmin, listAccountsForAdmin } from "./accountDetail.service";
import { listBroadcastMessages, sendBroadcastMessage } from "./broadcastMessage.service";
import { adminDeleteGalleryItem, listGalleryItems } from "../hosts/gallery.service";
import { endBroadcastAsAdmin, listLiveBroadcastsForAdmin, liveRoomName } from "../live/live.service";
import {
  createAdultModeConfig,
  createBeansEarnConfig,
  createCommissionConfig,
  createGift,
  createSubAdmin,
  createWithdrawalPolicyConfig,
  createWithdrawalSlabSet,
  decideKyc,
  getDashboardStats,
  getKycSubmissionForReview,
  listAdultModeConfigs,
  listAllGifts,
  listAuditLog,
  listBeansEarnConfigs,
  listCaptureEvents,
  listCommissionConfigs,
  listPendingKyc,
  listSubAdmins,
  listWithdrawalPolicyConfigs,
  listWithdrawalSlabConfigs,
  setAccountStatus,
  updateGift,
  updateSubAdminPermissions,
} from "./admin.service";
import { requireAdminPermission } from "./permissions";

export const adminRouter = Router();

adminRouter.use("/admin", requireAuth, requireRole("admin", "sub_admin"));

const uuidParam = z.string().uuid();
function parseId(raw: unknown, label: string): string {
  const result = uuidParam.safeParse(raw);
  if (!result.success) throw new AppError(400, `Invalid ${label}`);
  return result.data;
}

// ---------------------------------------------------------------------------
// KYC approval queue (BR-ADM-05) — moderation permission
// ---------------------------------------------------------------------------

adminRouter.get("/admin/kyc/pending", requireAdminPermission("moderation"), async (_req, res, next) => {
  try {
    res.json({ submissions: await listPendingKyc() });
  } catch (err) {
    next(err);
  }
});

// The full submission under review — documents (with fresh presigned view
// URLs), attempt number, submitted-at — for the "SUBMITTED DOCUMENTS"
// detail screen.
adminRouter.get("/admin/kyc/:userId", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    res.json(await getKycSubmissionForReview(parseId(req.params.userId, "user id")));
  } catch (err) {
    next(err);
  }
});

const kycDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() });

adminRouter.post(
  "/admin/kyc/:userId/decision",
  requireAdminPermission("moderation"),
  validateBody(kycDecisionSchema),
  async (req, res, next) => {
    try {
      const { decision, reason } = req.body as z.infer<typeof kycDecisionSchema>;
      const user = await decideKyc(req.user!.sub, parseId(req.params.userId, "user id"), decision, reason);
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Withdrawal approval queue (BR-ADM-05, BR-EARN-05) — finance permission
// ---------------------------------------------------------------------------

const withdrawalStatusQuery = z.enum(["pending", "approved", "processing", "paid", "rejected", "failed"]).optional();

adminRouter.get("/admin/withdrawals", requireAdminPermission("finance"), async (req, res, next) => {
  try {
    const result = withdrawalStatusQuery.safeParse(req.query.status);
    if (!result.success) throw new AppError(400, "Invalid status filter");
    res.json({ requests: await listWithdrawalsByStatus(result.data) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/admin/withdrawals/:id", requireAdminPermission("finance"), async (req, res, next) => {
  try {
    res.json(await getWithdrawalDetailForAdmin(parseId(req.params.id, "withdrawal id")));
  } catch (err) {
    next(err);
  }
});

const withdrawalDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

adminRouter.post(
  "/admin/withdrawals/:id/decision",
  requireAdminPermission("finance"),
  validateBody(withdrawalDecisionSchema),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id, "withdrawal id");
      const existing = await getWithdrawalById(id);
      if (!existing) throw new AppError(404, "Withdrawal request not found");
      if (existing.status !== "pending") throw new AppError(409, `Request is ${existing.status}, not pending`);

      const { decision } = req.body as z.infer<typeof withdrawalDecisionSchema>;
      const updated = await decideWithdrawal(id, decision);
      await writeAuditLog(req.user!.sub, `withdrawal.${decision}`, "withdrawal_request", id, {
        beans: existing.beans,
        convertedAmountPaise: existing.convertedAmountPaise,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Wallet reconciliation (BACKEND_PLAN.md §1 "Reconciliation job", Phase 11)
// — finance permission. On-demand check on top of the periodic background
// sweep (server.ts's startReconciliationSweep) — same underlying query,
// exposed for a human to check right now rather than waiting on the next
// scheduled run or grepping logs for a warning that already fired.
// ---------------------------------------------------------------------------

adminRouter.get("/admin/reconciliation", requireAdminPermission("finance"), async (_req, res, next) => {
  try {
    res.json(await reconcileAllWallets());
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Pricing/economics config (BR-ADM-02) — finance permission
// ---------------------------------------------------------------------------

adminRouter.get("/admin/config/commission", requireAdminPermission("finance"), async (req, res, next) => {
  try {
    const hostIdResult = z.string().uuid().optional().safeParse(req.query.hostId);
    if (!hostIdResult.success) throw new AppError(400, "Invalid hostId");
    res.json({ configs: await listCommissionConfigs(hostIdResult.data) });
  } catch (err) {
    next(err);
  }
});

// hostId (BR-COM-03) — a negotiated per-host rate, e.g. for a top earner.
// Omit it to set the global rate instead, same as before this existed.
const commissionConfigSchema = z.object({
  basisPoints: z.number().int().min(0).max(10_000),
  hostId: z.string().uuid().optional(),
});

adminRouter.post(
  "/admin/config/commission",
  requireAdminPermission("finance"),
  validateBody(commissionConfigSchema),
  async (req, res, next) => {
    try {
      const { basisPoints, hostId } = req.body as z.infer<typeof commissionConfigSchema>;
      res.status(201).json(await createCommissionConfig(req.user!.sub, basisPoints, hostId));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/admin/config/beans-rate", requireAdminPermission("finance"), async (_req, res, next) => {
  try {
    res.json({ configs: await listBeansEarnConfigs() });
  } catch (err) {
    next(err);
  }
});

const beansEarnConfigSchema = z.object({ paisePerBean: z.number().int().positive() });

adminRouter.post(
  "/admin/config/beans-rate",
  requireAdminPermission("finance"),
  validateBody(beansEarnConfigSchema),
  async (req, res, next) => {
    try {
      const { paisePerBean } = req.body as z.infer<typeof beansEarnConfigSchema>;
      res.status(201).json(await createBeansEarnConfig(req.user!.sub, paisePerBean));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/admin/config/withdrawal-policy", requireAdminPermission("finance"), async (_req, res, next) => {
  try {
    res.json({ configs: await listWithdrawalPolicyConfigs() });
  } catch (err) {
    next(err);
  }
});

const withdrawalPolicySchema = z.object({
  minAmountPaise: z.number().int().positive(),
  maxRequestsPerWindow: z.number().int().positive(),
  windowDays: z.number().int().positive(),
  autoApproveThresholdPaise: z.number().int().nonnegative(),
});

adminRouter.post(
  "/admin/config/withdrawal-policy",
  requireAdminPermission("finance"),
  validateBody(withdrawalPolicySchema),
  async (req, res, next) => {
    try {
      const policy = req.body as z.infer<typeof withdrawalPolicySchema>;
      res.status(201).json(await createWithdrawalPolicyConfig(req.user!.sub, policy));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/admin/config/withdrawal-slabs", requireAdminPermission("finance"), async (_req, res, next) => {
  try {
    res.json({ configs: await listWithdrawalSlabConfigs() });
  } catch (err) {
    next(err);
  }
});

const withdrawalSlabsSchema = z.object({
  slabs: z
    .array(
      z.object({
        minBeans: z.number().int().nonnegative(),
        maxBeans: z.number().int().positive().nullable(),
        paisePerBean: z.number().int().positive(),
      }),
    )
    .min(1),
});

adminRouter.post(
  "/admin/config/withdrawal-slabs",
  requireAdminPermission("finance"),
  validateBody(withdrawalSlabsSchema),
  async (req, res, next) => {
    try {
      const { slabs } = req.body as z.infer<typeof withdrawalSlabsSchema>;
      res.status(201).json({ configs: await createWithdrawalSlabSet(req.user!.sub, slabs) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// 18+ toggle (BR-MOD-01) — full ADMIN only, not gated by "moderation"
// permission like the rest of this section (admin design: "Accessible to
// Super Admin Only"). Flipping platform-wide adult-content policy is a
// bigger call than the day-to-day content moderation a moderation-scoped
// sub-admin otherwise handles.
// ---------------------------------------------------------------------------

adminRouter.get("/admin/config/adult-mode", requireRole("admin"), async (_req, res, next) => {
  try {
    res.json({ configs: await listAdultModeConfigs() });
  } catch (err) {
    next(err);
  }
});

const adultModeConfigSchema = z.object({ enabled: z.boolean() });

adminRouter.post(
  "/admin/config/adult-mode",
  requireRole("admin"),
  validateBody(adultModeConfigSchema),
  async (req, res, next) => {
    try {
      const { enabled } = req.body as z.infer<typeof adultModeConfigSchema>;
      res.status(201).json(await createAdultModeConfig(req.user!.sub, enabled));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/admin/capture-events", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    const limitResult = z.coerce.number().int().positive().max(500).default(100).safeParse(req.query.limit);
    if (!limitResult.success) throw new AppError(400, "Invalid limit");
    res.json({ events: await listCaptureEvents(limitResult.data) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Gift catalog CRUD (BR-ADM-02) — finance permission
// ---------------------------------------------------------------------------

adminRouter.get("/admin/gifts", requireAdminPermission("finance"), async (_req, res, next) => {
  try {
    res.json({ gifts: await listAllGifts() });
  } catch (err) {
    next(err);
  }
});

const createGiftSchema = z.object({
  name: z.string().min(1).max(100),
  iconUrl: z.string().url().optional(),
  pricePaise: z.number().int().positive(),
});

adminRouter.post(
  "/admin/gifts",
  requireAdminPermission("finance"),
  validateBody(createGiftSchema),
  async (req, res, next) => {
    try {
      res.status(201).json(await createGift(req.user!.sub, req.body as z.infer<typeof createGiftSchema>));
    } catch (err) {
      next(err);
    }
  },
);

const updateGiftSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  iconUrl: z.string().url().optional(),
  pricePaise: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});

adminRouter.patch(
  "/admin/gifts/:id",
  requireAdminPermission("finance"),
  validateBody(updateGiftSchema),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id, "gift id");
      const updates = req.body as z.infer<typeof updateGiftSchema>;
      res.json(await updateGift(req.user!.sub, id, updates));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// General User/Host roster + detail (admin design follow-up) — separate
// from the public discovery GET /hosts and from the KYC/withdrawal queues,
// which only ever show accounts with a pending action. moderation
// permission, same gate as the rest of account moderation below.
// ---------------------------------------------------------------------------

adminRouter.get("/admin/users", requireAdminPermission("moderation"), async (_req, res, next) => {
  try {
    res.json({ users: await listAccountsForAdmin("user") });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/admin/users/:id", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    res.json(await getAccountDetailForAdmin(parseId(req.params.id, "user id"), "user"));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/admin/hosts", requireAdminPermission("moderation"), async (_req, res, next) => {
  try {
    res.json({ hosts: await listAccountsForAdmin("host") });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/admin/hosts/:id", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    res.json(await getAccountDetailForAdmin(parseId(req.params.id, "host id"), "host"));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/admin/hosts/:id/gallery", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    res.json({ items: await listGalleryItems(parseId(req.params.id, "host id")) });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete(
  "/admin/hosts/:id/gallery/:itemId",
  requireAdminPermission("moderation"),
  async (req, res, next) => {
    try {
      parseId(req.params.id, "host id"); // just validates the URL is well-formed; the item itself is the source of truth
      const deleted = await adminDeleteGalleryItem(parseId(req.params.itemId, "gallery item id"));
      await writeAuditLog(req.user!.sub, "gallery.delete", "host_gallery_item", deleted.id, {
        hostId: deleted.hostId,
        mediaType: deleted.mediaType,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Account moderation — suspend/ban/reactivate (BR-ACC-05, BR-MOD-05) and
// the content/user report queue (BR-MOD-04) — moderation permission
// ---------------------------------------------------------------------------

const accountStatusSchema = z.object({
  status: z.enum(["active", "suspended", "banned"]),
  reason: z.string().max(500).optional(),
});

adminRouter.post(
  "/admin/users/:id/status",
  requireAdminPermission("moderation"),
  validateBody(accountStatusSchema),
  async (req, res, next) => {
    try {
      const { status, reason } = req.body as z.infer<typeof accountStatusSchema>;
      const id = parseId(req.params.id, "user id");
      res.json(await setAccountStatus(req.user!.sub, id, status, reason));
    } catch (err) {
      next(err);
    }
  },
);

const reportStatusQuery = z.enum(["pending", "resolved", "dismissed"]).optional();

adminRouter.get("/admin/moderation", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    const result = reportStatusQuery.safeParse(req.query.status);
    if (!result.success) throw new AppError(400, "Invalid status filter");
    res.json({ reports: await listReports(result.data) });
  } catch (err) {
    next(err);
  }
});

// Admin design: Dismiss / Warn / Suspend / Ban as one combined choice on
// the report screen. accountAction is only valid when the report targets
// an account (user/host), not a piece of content — validated before
// resolving the report, not after, so a bad accountAction can't leave the
// report resolved with the requested account consequence never applied.
const resolveReportSchema = z.object({
  action: z.enum(["resolved", "dismissed"]),
  note: z.string().max(500).optional(),
  accountAction: z.enum(["warn", "suspend", "ban"]).optional(),
});

adminRouter.post(
  "/admin/moderation/:id/resolve",
  requireAdminPermission("moderation"),
  validateBody(resolveReportSchema),
  async (req, res, next) => {
    try {
      const { action, note, accountAction } = req.body as z.infer<typeof resolveReportSchema>;
      const id = parseId(req.params.id, "report id");

      if (accountAction) {
        const existing = await getReportById(id);
        if (!existing) throw new AppError(404, "Report not found");
        if (existing.targetType !== "user" && existing.targetType !== "host") {
          throw new AppError(400, `Cannot ${accountAction} a report targeting a ${existing.targetType}, not an account`);
        }
      }

      const report = await resolveReport(req.user!.sub, id, action, note);

      if (accountAction === "warn") {
        await warnAccount(req.user!.sub, report.targetId, note);
      } else if (accountAction === "suspend" || accountAction === "ban") {
        await setAccountStatus(req.user!.sub, report.targetId, accountAction === "suspend" ? "suspended" : "banned", note);
      }

      res.json(report);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Sub-admin management (BR-ADM-03) — full ADMIN only, not permission-gated
// ---------------------------------------------------------------------------

adminRouter.get("/admin/sub-admins", requireRole("admin"), async (_req, res, next) => {
  try {
    res.json({ subAdmins: await listSubAdmins() });
  } catch (err) {
    next(err);
  }
});

const permissionsList = z.array(z.enum(["finance", "moderation", "analytics"]));
const createSubAdminSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone must be in E.164 format, e.g. +919876543210"),
  email: z.string().email(),
  password: z.string().min(8),
  permissions: permissionsList,
});

adminRouter.post(
  "/admin/sub-admins",
  requireRole("admin"),
  validateBody(createSubAdminSchema),
  async (req, res, next) => {
    try {
      const { phone, email, password, permissions } = req.body as z.infer<typeof createSubAdminSchema>;
      res.status(201).json(await createSubAdmin(req.user!.sub, phone, email, password, permissions));
    } catch (err) {
      next(err);
    }
  },
);

const updatePermissionsSchema = z.object({ permissions: permissionsList });

adminRouter.patch(
  "/admin/sub-admins/:id/permissions",
  requireRole("admin"),
  validateBody(updatePermissionsSchema),
  async (req, res, next) => {
    try {
      const { permissions } = req.body as z.infer<typeof updatePermissionsSchema>;
      const id = parseId(req.params.id, "sub-admin id");
      res.json(await updateSubAdminPermissions(req.user!.sub, id, permissions));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Audit log (BR-ADM-04) — analytics permission, same "read-only oversight"
// scope as the dashboard below.
// ---------------------------------------------------------------------------

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  adminId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

adminRouter.get("/admin/audit-log", requireAdminPermission("analytics"), async (req, res, next) => {
  try {
    const result = auditLogQuerySchema.safeParse(req.query);
    if (!result.success) throw new AppError(400, result.error.issues.map((i) => i.message).join(", "));
    const { limit, adminId, from, to } = result.data;
    res.json({
      entries: await listAuditLog(limit, adminId, from ? new Date(from) : undefined, to ? new Date(to) : undefined),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Analytics dashboard (BR-ADM-01) — analytics permission (also implicitly
// available to finance/moderation sub-admins via role=admin's full access;
// a sub-admin scoped to only finance or moderation needs "analytics" too)
// ---------------------------------------------------------------------------

// ?from=&to= (ISO dates) scope revenue/commission/call-minutes/the chart
// series/top earners to a period — admin design's "Last 30 days" selector.
// Both omitted defaults to the last 30 days (getDashboardStats's own
// default), not all-time.
const dashboardQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

adminRouter.get("/admin/dashboard", requireAdminPermission("analytics"), async (req, res, next) => {
  try {
    const result = dashboardQuerySchema.safeParse(req.query);
    if (!result.success) throw new AppError(400, "Invalid from/to — must be ISO date-times");
    const { from, to } = result.data;
    res.json(await getDashboardStats(from ? new Date(from) : undefined, to ? new Date(to) : undefined));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Live Broadcasts admin view (admin design follow-up) — moderation
// permission, same gate as the rest of content moderation.
// ---------------------------------------------------------------------------

adminRouter.get("/admin/live-broadcasts", requireAdminPermission("moderation"), async (_req, res, next) => {
  try {
    res.json({ broadcasts: await listLiveBroadcastsForAdmin() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/admin/live-broadcasts/:id/end", requireAdminPermission("moderation"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "broadcast id");
    const broadcast = await endBroadcastAsAdmin(id);
    // Same "tell whoever's still in the room" step live.routes.ts's
    // host-initiated end does — this bypasses that route entirely, so it
    // has to be repeated here rather than shared.
    emitToRoom(liveRoomName(id), "live:ended", { broadcastId: id });
    await writeAuditLog(req.user!.sub, "live_broadcast.force_end", "live_broadcast", id, { hostId: broadcast.hostId });
    res.json(broadcast);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Broadcast messaging (admin design follow-up) — a titled message to every
// User, every Host, or both. moderation permission — this is a
// communications/content tool, not tied to money (finance) or read-only
// reporting (analytics).
// ---------------------------------------------------------------------------

adminRouter.get("/admin/broadcast-messages", requireAdminPermission("moderation"), async (_req, res, next) => {
  try {
    res.json({ messages: await listBroadcastMessages() });
  } catch (err) {
    next(err);
  }
});

const broadcastMessageSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  recipients: z.enum(["all_users", "all_hosts", "all"]),
});

adminRouter.post(
  "/admin/broadcast-messages",
  requireAdminPermission("moderation"),
  validateBody(broadcastMessageSchema),
  async (req, res, next) => {
    try {
      const { title, message, recipients } = req.body as z.infer<typeof broadcastMessageSchema>;
      res.status(201).json(await sendBroadcastMessage(req.user!.sub, title, message, recipients));
    } catch (err) {
      next(err);
    }
  },
);

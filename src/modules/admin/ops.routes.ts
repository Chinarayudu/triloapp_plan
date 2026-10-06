import { Request, Router } from "express";
import { z } from "zod";
import { writeAuditLog } from "../../lib/auditLog";
import { addDays, dateInTimeZone, isValidDateString, isValidTimeZone } from "../../lib/dayBounds";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToRoom } from "../../realtime/socket";
import { endCallAsAdmin } from "../calls/calls.service";
import { getCallForAdmin, listCallsForAdmin, listLiveCallsForAdmin } from "../calls/callsAdmin.service";
import { listGiftRequestsForAdmin, listGiftTransactionsForAdmin } from "../gifts/giftsAdmin.service";
import { endBroadcastAsAdmin, listBroadcastsForLiveMonitor, liveRoomName } from "../live/live.service";
import { getReportConversation } from "../moderation/reportConversation.service";
import { listSecurityEvents } from "../moderation/securityEvents.service";
import { getAppSettings, setAppSettings } from "../settings/appSettings.service";
import { getUserById } from "../users/users.service";
import { getHostDailySummary, getHostRangeSummary } from "../wallet/dailyStats.service";
import { adjustUserWallet, getUserWalletForAdmin } from "../wallet/walletAdmin.service";
import { getDashboardInsights } from "./insights.service";
import { requireAdminPermission } from "./permissions";

// Admin operations endpoints (calls, live monitor, gifts, security events,
// user wallets, host performance, reported chat, dashboard insights, app
// settings). Mounted once at the root, like adminRouter. Every write is
// audit-logged with the admin, the target, before/after values and the reason.

export const opsAdminRouter = Router();
const as = (permission: "finance" | "moderation" | "analytics") => [requireAuth, requireAdminPermission(permission)];

function parseId(raw: unknown, label: string): string {
  const result = z.string().uuid().safeParse(raw);
  if (!result.success) throw new AppError(400, `Invalid ${label}`);
  return result.data;
}

function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new AppError(400, result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
  return result.data;
}

const DEFAULT_TZ = "Asia/Kolkata";
const tz = z
  .string()
  .default(DEFAULT_TZ)
  .refine(isValidTimeZone, "tz must be an IANA time zone, e.g. Asia/Kolkata");
const localDate = z.string().refine(isValidDateString, "must be YYYY-MM-DD");
const paging = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
};
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });

// A required from..to range; to defaults to today and from to `days` before it.
function dateRange(days: number) {
  return z
    .object({ from: localDate.optional(), to: localDate.optional(), tz })
    .transform((v) => {
      const to = v.to ?? dateInTimeZone(new Date(), v.tz);
      const from = v.from ?? addDays(to, -(days - 1));
      return { from, to, tz: v.tz };
    })
    .refine((v) => v.from <= v.to, "from must not be after to")
    .refine((v) => addDays(v.from, 92) > v.to, "The range can be at most 92 days");
}

// ---- Calls (moderation) ------------------------------------------------------

opsAdminRouter.get("/admin/calls/live", ...as("moderation"), async (_req, res, next) => {
  try {
    res.json(await listLiveCallsForAdmin());
  } catch (err) {
    next(err);
  }
});

const callListQuery = z.object({
  filter: z.enum(["all", "video", "voice", "missed"]).default("all"),
  userId: z.string().uuid().optional(),
  hostId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  from: localDate.optional(),
  to: localDate.optional(),
  tz,
  ...paging,
});

opsAdminRouter.get("/admin/calls", ...as("moderation"), async (req, res, next) => {
  try {
    res.json(await listCallsForAdmin(parseQuery(callListQuery, req)));
  } catch (err) {
    next(err);
  }
});

opsAdminRouter.get("/admin/calls/:id", ...as("moderation"), async (req, res, next) => {
  try {
    res.json(await getCallForAdmin(parseId(req.params.id, "call id")));
  } catch (err) {
    next(err);
  }
});

opsAdminRouter.post("/admin/calls/:id/end", ...as("moderation"), validateBody(reasonSchema), async (req, res, next) => {
  try {
    const callId = parseId(req.params.id, "call id");
    const { reason } = req.body as z.infer<typeof reasonSchema>;
    const before = await getCallForAdmin(callId);
    await endCallAsAdmin(callId);
    const after = await getCallForAdmin(callId);
    await writeAuditLog(req.user!.sub, "call.force_end", "call", callId, {
      reason,
      before: { status: before.status },
      after: { status: after.status, endReason: after.endReason, totalAmountPaise: after.totalAmountPaise },
    });
    res.json(after);
  } catch (err) {
    next(err);
  }
});

// ---- Live monitor (moderation) -------------------------------------------------

const liveListQuery = z.object({ status: z.enum(["live", "ended"]).default("live") });

opsAdminRouter.get("/admin/live/broadcasts", ...as("moderation"), async (req, res, next) => {
  try {
    const { status } = parseQuery(liveListQuery, req);
    res.json({ broadcasts: await listBroadcastsForLiveMonitor(status) });
  } catch (err) {
    next(err);
  }
});

// Same as POST /admin/live-broadcasts/:id/end, with the reason the spec asks for.
opsAdminRouter.post("/admin/live/broadcasts/:id/end", ...as("moderation"), validateBody(reasonSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "broadcast id");
    const { reason } = req.body as z.infer<typeof reasonSchema>;
    const broadcast = await endBroadcastAsAdmin(id);
    emitToRoom(liveRoomName(id), "live:ended", { broadcastId: id });
    await writeAuditLog(req.user!.sub, "live_broadcast.force_end", "live_broadcast", id, {
      reason,
      hostId: broadcast.hostId,
      before: { status: "live" },
      after: { status: broadcast.status },
    });
    res.json(broadcast);
  } catch (err) {
    next(err);
  }
});

// ---- Gifts (analytics) ----------------------------------------------------------

const giftTransactionQuery = z.object({
  context: z.enum(["call", "live", "chat"]).optional(),
  hostId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: localDate.optional(),
  to: localDate.optional(),
  tz,
  ...paging,
});

opsAdminRouter.get("/admin/gifts/transactions", ...as("analytics"), async (req, res, next) => {
  try {
    res.json(await listGiftTransactionsForAdmin(parseQuery(giftTransactionQuery, req)));
  } catch (err) {
    next(err);
  }
});

const giftRequestQuery = z.object({
  status: z.enum(["pending", "accepted", "declined"]).optional(),
  hostId: z.string().uuid().optional(),
  ...paging,
});

opsAdminRouter.get("/admin/gifts/requests", ...as("analytics"), async (req, res, next) => {
  try {
    res.json(await listGiftRequestsForAdmin(parseQuery(giftRequestQuery, req)));
  } catch (err) {
    next(err);
  }
});

// ---- Security events (moderation) -----------------------------------------------

const securityEventQuery = z.object({
  role: z.enum(["user", "host"]).optional(),
  type: z.enum(["SCREENSHOT_ATTEMPT", "SCREEN_RECORDING_SUSPECTED", "PAGE_HIDDEN", "DEVTOOLS_OPENED"]).optional(),
  accountId: z.string().uuid().optional(),
  from: localDate.optional(),
  to: localDate.optional(),
  tz,
  ...paging,
});

opsAdminRouter.get("/admin/security-events", ...as("moderation"), async (req, res, next) => {
  try {
    res.json(await listSecurityEvents(parseQuery(securityEventQuery, req)));
  } catch (err) {
    next(err);
  }
});

// ---- User wallet & refunds (finance) ----------------------------------------------

const walletQuery = z.object({ page: paging.page, pageSize: z.coerce.number().int().positive().max(200).default(50) });

opsAdminRouter.get("/admin/users/:id/wallet", ...as("finance"), async (req, res, next) => {
  try {
    const { page, pageSize } = parseQuery(walletQuery, req);
    res.json(await getUserWalletForAdmin(parseId(req.params.id, "user id"), page, pageSize));
  } catch (err) {
    next(err);
  }
});

const adjustmentSchema = z.object({
  // Signed paise: positive credits/refunds, negative corrects the balance down.
  amountPaise: z.number().int().refine((v) => v !== 0, "amountPaise can't be 0").refine((v) => Math.abs(v) <= 10_000_000, "amountPaise is too large"),
  reason: z.string().trim().min(5, "reason must be at least 5 characters").max(500),
  reference: z.string().trim().min(1).max(100).nullish(),
});

opsAdminRouter.post("/admin/users/:id/adjustments", ...as("finance"), validateBody(adjustmentSchema), async (req, res, next) => {
  try {
    const { amountPaise, reason, reference } = req.body as z.infer<typeof adjustmentSchema>;
    const result = await adjustUserWallet(req.user!.sub, parseId(req.params.id, "user id"), amountPaise, reason, reference ?? null);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Host performance (analytics) -------------------------------------------------

async function requireHost(id: string): Promise<void> {
  const host = await getUserById(id);
  if (!host || host.role !== "host") throw new AppError(404, "Host not found");
}

opsAdminRouter.get("/admin/hosts/:id/stats/daily-summary", ...as("analytics"), async (req, res, next) => {
  try {
    const hostId = parseId(req.params.id, "host id");
    await requireHost(hostId);
    const { from, to, tz: zone } = parseQuery(dateRange(14), req);
    res.json(await getHostDailySummary(hostId, from, to, zone));
  } catch (err) {
    next(err);
  }
});

opsAdminRouter.get("/admin/hosts/:id/stats/summary", ...as("analytics"), async (req, res, next) => {
  try {
    const hostId = parseId(req.params.id, "host id");
    await requireHost(hostId);
    const { from, to, tz: zone } = parseQuery(dateRange(14), req);
    res.json(await getHostRangeSummary(hostId, from, to, zone));
  } catch (err) {
    next(err);
  }
});

// ---- Moderation: reported chat (moderation) ---------------------------------------
// Admins are reading private messages, so every view is audit-logged.

opsAdminRouter.get("/admin/moderation/:reportId/conversation", ...as("moderation"), async (req, res, next) => {
  try {
    const reportId = parseId(req.params.reportId, "report id");
    const conversation = await getReportConversation(reportId);
    await writeAuditLog(req.user!.sub, "moderation.view_conversation", "moderation_report", reportId, {
      conversationId: conversation.conversationId,
      messagesShown: conversation.messages.length,
    });
    res.json(conversation);
  } catch (err) {
    next(err);
  }
});

// ---- Dashboard insights (analytics) -------------------------------------------------

opsAdminRouter.get("/admin/dashboard/insights", ...as("analytics"), async (req, res, next) => {
  try {
    const { from, to, tz: zone } = parseQuery(dateRange(14), req);
    res.json(await getDashboardInsights(from, to, zone));
  } catch (err) {
    next(err);
  }
});

// ---- App settings (finance) ----------------------------------------------------------

opsAdminRouter.get("/admin/config/app-settings", ...as("finance"), async (_req, res, next) => {
  try {
    res.json(await getAppSettings());
  } catch (err) {
    next(err);
  }
});

const positiveInt = z.number().int().positive();
const appSettingsSchema = z.object({
  dailyGoalSeconds: positiveInt.max(86_400),
  callQuality: z.object({ goodFromSeconds: positiveInt, excellentFromSeconds: positiveInt }),
  messagePrice: z.object({ minPaise: positiveInt, maxPaise: positiveInt }),
  liveCommentMaxLength: positiveInt.max(10_000),
  reason: z.string().trim().max(500).optional(),
});

opsAdminRouter.post("/admin/config/app-settings", ...as("finance"), async (req, res, next) => {
  try {
    // 422 (not 400) for values that are well-formed but don't make sense together, per the spec.
    const parsed = appSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    const { reason, ...settings } = parsed.data;
    if (settings.callQuality.excellentFromSeconds <= settings.callQuality.goodFromSeconds) {
      throw new AppError(422, "callQuality.excellentFromSeconds must be greater than goodFromSeconds");
    }
    if (settings.messagePrice.maxPaise < settings.messagePrice.minPaise) {
      throw new AppError(422, "messagePrice.maxPaise must be at least minPaise");
    }
    res.status(201).json(await setAppSettings(req.user!.sub, settings, reason));
  } catch (err) {
    next(err);
  }
});

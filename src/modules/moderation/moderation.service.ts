import { count, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { captureEventContextEnum, captureEvents, moderationReports } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { writeAuditLog } from "../../lib/auditLog";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";
import { getUserById } from "../users/users.service";

type ModerationReport = typeof moderationReports.$inferSelect;
type TargetType = ModerationReport["targetType"];
type CaptureEventContext = (typeof captureEventContextEnum.enumValues)[number];
type CapturePolicyAction = "logged" | "warning" | "escalated_for_review";

// BR-MOD-04: any User/Host can report another account or a piece of
// content; it lands straight in the admin queue with no auto-triage.
export async function createReport(
  reporterId: string,
  targetType: TargetType,
  targetId: string,
  reason: string,
): Promise<ModerationReport> {
  const [row] = await db.insert(moderationReports).values({ reporterId, targetType, targetId, reason }).returning();
  return row;
}

export async function getReportById(reportId: string): Promise<ModerationReport | undefined> {
  const [row] = await db.select().from(moderationReports).where(eq(moderationReports.id, reportId)).limit(1);
  return row;
}

export async function listReports(status?: ModerationReport["status"]): Promise<ModerationReport[]> {
  if (status) {
    return db
      .select()
      .from(moderationReports)
      .where(eq(moderationReports.status, status))
      .orderBy(desc(moderationReports.createdAt));
  }
  return db.select().from(moderationReports).orderBy(desc(moderationReports.createdAt));
}

// admin.routes.ts is where account suspension (BR-MOD-05) actually happens,
// as a separate explicit action against admin.service.ts's setAccountStatus
// — resolving a report never suspends an account by itself, since not
// every report warrants one.
export async function resolveReport(
  adminId: string,
  reportId: string,
  action: "resolved" | "dismissed",
  note?: string,
): Promise<ModerationReport> {
  const [existing] = await db.select().from(moderationReports).where(eq(moderationReports.id, reportId)).limit(1);
  if (!existing) throw new AppError(404, "Report not found");
  if (existing.status !== "pending") throw new AppError(409, `Report is already ${existing.status}`);

  const [updated] = await db
    .update(moderationReports)
    .set({ status: action, resolvedByAdminId: adminId, resolutionNote: note, resolvedAt: new Date() })
    .where(eq(moderationReports.id, reportId))
    .returning();

  await writeAuditLog(adminId, `moderation.${action}`, "moderation_report", reportId, note ? { note } : undefined);
  return updated;
}

// The lightest of the four moderation outcomes (admin design: Dismiss /
// Warn / Suspend / Ban as one choice on the report screen) — notifies the
// account, changes nothing about its status. Suspend/ban go through
// admin.service.ts's setAccountStatus instead (admin.routes.ts
// orchestrates both against the same report resolution).
export async function warnAccount(adminId: string, accountId: string, note?: string): Promise<void> {
  const message = note ?? "You have received a warning from the platform for violating our community guidelines.";
  emitToUser(accountId, "account:warning", { message });
  if (!(await isUserConnected(accountId))) {
    void sendPushNotification(accountId, "Warning", message);
  }
  await writeAuditLog(adminId, "moderation.warn", "user", accountId, note ? { note } : undefined);
}

// BR-MOD-03: the client calls this when it detects a screen capture/
// recording attempt (Android FLAG_SECURE fired, iOS
// UIScreen.capturedDidChangeNotification) — the backend only logs and
// escalates, since the actual blocking is client/OS-side and out of our
// control. Deliberately never auto-suspends on this alone: capture
// detection can false-positive (e.g. a legitimate OS screenshot on some
// Android versions), so past a threshold this only *flags* the account for
// a human moderator via the same report queue BR-MOD-04 already built —
// resolving that report still requires an explicit setAccountStatus call,
// same as any other report.
const WARNING_THRESHOLD = 2;
const ESCALATION_THRESHOLD = 4;

export async function logCaptureEvent(
  userId: string,
  context: CaptureEventContext,
  contextId?: string,
): Promise<{ totalCaptureEvents: number; policyAction: CapturePolicyAction }> {
  await db.insert(captureEvents).values({ userId, context, contextId });

  const [{ value: totalCaptureEvents }] = await db
    .select({ value: count() })
    .from(captureEvents)
    .where(eq(captureEvents.userId, userId));

  // Filed exactly once, at the moment the count crosses the threshold —
  // not on every subsequent event past it, so the queue doesn't fill with
  // duplicate entries for the same account once a human is already on it.
  if (totalCaptureEvents === ESCALATION_THRESHOLD) {
    const user = await getUserById(userId);
    const targetType: TargetType = user?.role === "host" ? "host" : "user";
    await createReport(
      userId,
      targetType,
      userId,
      `Automated: ${totalCaptureEvents} screen-capture attempts detected across this account's sessions`,
    );
    return { totalCaptureEvents, policyAction: "escalated_for_review" };
  }

  if (totalCaptureEvents >= WARNING_THRESHOLD) {
    return { totalCaptureEvents, policyAction: "warning" };
  }

  return { totalCaptureEvents, policyAction: "logged" };
}

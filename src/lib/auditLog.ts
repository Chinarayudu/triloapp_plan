import { db } from "../db/client";
import { auditLogs } from "../db/schema";

// Every privileged admin action that changes money-affecting config or
// account status calls this (BR-ADM-04) — reviewed later via
// admin.service.ts's listAuditLog, never edited or deleted.
export async function writeAuditLog(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    adminId,
    action,
    targetType,
    targetId,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

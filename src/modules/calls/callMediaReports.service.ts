import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { callMediaReports, calls } from "../../db/schema";
import { AppError } from "../../lib/errors";

export type CallMediaReportInput = {
  connected: boolean;
  connectMs?: number;
  relayed?: boolean;
  avgRttMs?: number;
  packetLossPercent?: number;
  avgVideoKbps?: number;
};

// One report per participant per call; a repeat (app retry) is ignored rather
// than refused, so the app never has to care whether its first attempt landed.
export async function submitCallMediaReport(callId: string, reporterId: string, report: CallMediaReportInput): Promise<void> {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!call) throw new AppError(404, "Call not found");
  if (call.userId !== reporterId && call.hostId !== reporterId) throw new AppError(403, "Not your call");
  if (!call.startedAt) throw new AppError(409, "This call never connected");

  await db
    .insert(callMediaReports)
    .values({
      callId,
      reporterId,
      mediaProvider: call.mediaProvider,
      connected: report.connected,
      connectMs: report.connectMs ?? null,
      relayed: report.relayed ?? null,
      avgRttMs: report.avgRttMs ?? null,
      packetLossPercent: report.packetLossPercent ?? null,
      avgVideoKbps: report.avgVideoKbps ?? null,
    })
    .onConflictDoNothing();
}

// Admin comparison of p2p vs Agora over the last `days` days — the numbers to
// check before raising the "auto" rollout percentage.
export async function getCallMediaQuality(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const byProvider = await db
    .select({
      mediaProvider: callMediaReports.mediaProvider,
      reports: sql<number>`count(*)::int`,
      connectedPercent: sql<number | null>`round(100.0 * avg(case when ${callMediaReports.connected} then 1 else 0 end), 1)::float`,
      relayedPercent: sql<number | null>`round(100.0 * avg(case when ${callMediaReports.relayed} then 1 when not ${callMediaReports.relayed} then 0 end), 1)::float`,
      avgConnectMs: sql<number | null>`round(avg(${callMediaReports.connectMs}))::int`,
      avgRttMs: sql<number | null>`round(avg(${callMediaReports.avgRttMs}))::int`,
      avgPacketLossPercent: sql<number | null>`round(avg(${callMediaReports.packetLossPercent})::numeric, 2)::float`,
      avgVideoKbps: sql<number | null>`round(avg(${callMediaReports.avgVideoKbps}))::int`,
    })
    .from(callMediaReports)
    .where(gte(callMediaReports.createdAt, since))
    .groupBy(callMediaReports.mediaProvider);

  // Fallback rate among calls that started on p2p under "auto".
  const [auto] = await db
    .select({
      autoCalls: sql<number>`count(*)::int`,
      fellBackToAgora: sql<number>`count(${calls.mediaFallbackAt})::int`,
    })
    .from(calls)
    .where(and(eq(calls.agoraFallbackAllowed, true), gte(calls.createdAt, since)));

  return { days, since, byProvider, autoCalls: auto.autoCalls, fellBackToAgora: auto.fellBackToAgora };
}

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { callRatings, calls } from "../../db/schema";
import { AppError } from "../../lib/errors";

export type RatingSummary = { average: number | null; count: number };

// Either call participant can rate the other once the call has ended (Host
// app's call-ended screen) — one rating per (call, rater), enforced by the
// unique constraint on call_ratings.
export async function submitRating(callId: string, raterId: string, stars: number) {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!call) throw new AppError(404, "Call not found");
  if (call.status !== "completed") throw new AppError(409, `Call is ${call.status}, cannot rate yet`);
  if (call.userId !== raterId && call.hostId !== raterId) throw new AppError(403, "Not your call");

  const ratedUserId = raterId === call.userId ? call.hostId : call.userId;

  const [existing] = await db
    .select()
    .from(callRatings)
    .where(and(eq(callRatings.callId, callId), eq(callRatings.raterId, raterId)))
    .limit(1);
  if (existing) {
    throw new AppError(409, "You already rated this call");
  }

  const [rating] = await db.insert(callRatings).values({ callId, raterId, ratedUserId, stars }).returning();
  return rating;
}

export async function getHostRatingSummary(hostId: string): Promise<RatingSummary> {
  const summaries = await getHostRatingSummaries([hostId]);
  return summaries.get(hostId) ?? { average: null, count: 0 };
}

// Batched for host-listing screens (hosts.service.ts's listHosts) — one
// GROUP BY query merged into an already-fetched host list, same "merge
// presence into the list in application code" pattern that module already
// uses for online/offline state.
export async function getHostRatingSummaries(hostIds: string[]): Promise<Map<string, RatingSummary>> {
  const summaries = new Map<string, RatingSummary>();
  if (hostIds.length === 0) return summaries;

  const rows = await db
    .select({
      hostId: callRatings.ratedUserId,
      average: sql<string>`avg(${callRatings.stars})`,
      count: sql<string>`count(*)`,
    })
    .from(callRatings)
    .where(inArray(callRatings.ratedUserId, hostIds))
    .groupBy(callRatings.ratedUserId);

  for (const row of rows) {
    summaries.set(row.hostId, { average: Math.round(Number(row.average) * 10) / 10, count: Number(row.count) });
  }
  return summaries;
}

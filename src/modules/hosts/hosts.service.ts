import { and, count, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { hostFollows, hostGalleryItems, hostProfiles, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { getHostRatingSummaries, getHostRatingSummary, RatingSummary } from "../calls/ratings.service";
import { listOnlineHostIds } from "./presence.store";

export type HostListSort = "rate_asc" | "rate_desc" | "online_first" | "rating_desc";

export type HostListParams = {
  onlineOnly: boolean;
  sort?: HostListSort;
  q?: string;
  page: number;
  pageSize: number;
};

export type HostListItem = {
  id: string;
  name: string | null;
  bio: string | null;
  gallery: string[];
  ratePerMinutePaise: number | null;
  isOnline: boolean;
  rating: RatingSummary;
  galleryCount: number;
};

// Batched — one GROUP BY query for every host in the list, same "merge into
// an already-fetched list" pattern as ratings/presence in this module.
async function getGalleryCounts(hostIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (hostIds.length === 0) return counts;
  const rows = await db
    .select({ hostId: hostGalleryItems.hostId, value: count() })
    .from(hostGalleryItems)
    .where(or(...hostIds.map((id) => eq(hostGalleryItems.hostId, id))))
    .groupBy(hostGalleryItems.hostId);
  for (const row of rows) counts.set(row.hostId, Number(row.value));
  return counts;
}

export async function listHosts(
  params: HostListParams,
): Promise<{ hosts: HostListItem[]; total: number; page: number; pageSize: number }> {
  const conditions = [eq(users.role, "host"), eq(users.status, "active")];
  // Search screen — partial match on name or any spoken language.
  if (params.q) {
    const pattern = `%${params.q}%`;
    conditions.push(
      or(
        ilike(users.name, pattern),
        sql`EXISTS (SELECT 1 FROM unnest(${hostProfiles.languages}) AS lang WHERE lang ILIKE ${pattern})`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      bio: hostProfiles.bio,
      gallery: hostProfiles.gallery,
      ratePerMinutePaise: hostProfiles.ratePerMinutePaise,
    })
    .from(users)
    .innerJoin(hostProfiles, eq(hostProfiles.userId, users.id))
    .where(and(...conditions));

  const onlineIds = new Set(listOnlineHostIds());
  const [ratings, galleryCounts] = await Promise.all([
    getHostRatingSummaries(rows.map((r) => r.id)),
    getGalleryCounts(rows.map((r) => r.id)),
  ]);
  let hosts: HostListItem[] = rows.map((r) => ({
    ...r,
    isOnline: onlineIds.has(r.id),
    rating: ratings.get(r.id) ?? { average: null, count: 0 },
    galleryCount: galleryCounts.get(r.id) ?? 0,
  }));

  if (params.onlineOnly) {
    hosts = hosts.filter((h) => h.isOnline);
  }

  // Presence/ratings are merged in above rather than queried in SQL, so
  // sorting on either — or on anything else merged in after the query —
  // has to happen here in application code rather than as a SQL ORDER BY.
  if (params.sort === "rate_asc") {
    hosts.sort((a, b) => (a.ratePerMinutePaise ?? Infinity) - (b.ratePerMinutePaise ?? Infinity));
  } else if (params.sort === "rate_desc") {
    hosts.sort((a, b) => (b.ratePerMinutePaise ?? -Infinity) - (a.ratePerMinutePaise ?? -Infinity));
  } else if (params.sort === "online_first") {
    hosts.sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
  } else if (params.sort === "rating_desc") {
    hosts.sort((a, b) => (b.rating.average ?? -Infinity) - (a.rating.average ?? -Infinity));
  }

  const total = hosts.length;
  const start = (params.page - 1) * params.pageSize;
  const paged = hosts.slice(start, start + params.pageSize);

  return { hosts: paged, total, page: params.page, pageSize: params.pageSize };
}

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const diffMs = Date.now() - new Date(dob).getTime();
  return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
}

// Creator Profile screen (User app design follow-up) — currently missing
// entirely; GET /hosts (list) is the only thing that existed before this.
export async function getHostDetail(hostId: string, viewerId: string) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      dob: users.dob,
      bio: hostProfiles.bio,
      gallery: hostProfiles.gallery,
      ratePerMinutePaise: hostProfiles.ratePerMinutePaise,
      voiceRatePerMinutePaise: hostProfiles.voiceRatePerMinutePaise,
      languages: hostProfiles.languages,
      talksAboutTags: hostProfiles.talksAboutTags,
      hobbies: hostProfiles.hobbies,
      sports: hostProfiles.sports,
    })
    .from(users)
    .innerJoin(hostProfiles, eq(hostProfiles.userId, users.id))
    .where(and(eq(users.id, hostId), eq(users.role, "host"), eq(users.status, "active")))
    .limit(1);
  if (!row) throw new AppError(404, "Host not found");

  const [{ value: followerCount }] = await db.select({ value: count() }).from(hostFollows).where(eq(hostFollows.hostId, hostId));
  const [{ value: isFollowingCount }] = await db
    .select({ value: count() })
    .from(hostFollows)
    .where(and(eq(hostFollows.hostId, hostId), eq(hostFollows.userId, viewerId)));

  const { dob, ...publicFields } = row; // dob itself is PII — only the derived age is public

  return {
    ...publicFields,
    age: ageFromDob(dob),
    isOnline: listOnlineHostIds().includes(hostId),
    rating: await getHostRatingSummary(hostId),
    followerCount: Number(followerCount),
    isFollowing: Number(isFollowingCount) > 0,
  };
}

import { and, count, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { calls, hostFollows, hostGalleryItems, hostProfiles, hostWallets, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { getHostRatingSummaries, getHostRatingSummary, RatingSummary } from "../calls/ratings.service";
import { effectiveRate, getHostEffectivePrices, levelForLifetimeBeans, pricesForLevel } from "./levels";
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
  avatarUrl: string | null;
  bio: string | null;
  gallery: string[];
  level: number;
  // What a user is charged right now — host's own rate capped at their level
  // maximum, or the level price if unset (hosts/levels.ts). Never null.
  ratePerMinutePaise: number;
  voiceRatePerMinutePaise: number;
  messageRatePaise: number;
  isOnline: boolean;
  // In an ongoing (accepted) call right now — kept live by the host:busy event.
  isBusy: boolean;
  rating: RatingSummary;
  galleryCount: number;
};

// Batched like getGalleryCounts below. Read from the calls table itself, not
// a separate flag, so it can never drift from the call state machine.
async function getBusyHostIds(hostIds: string[]): Promise<Set<string>> {
  if (hostIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ hostId: calls.hostId })
    .from(calls)
    .where(and(eq(calls.status, "ongoing"), or(...hostIds.map((id) => eq(calls.hostId, id)))));
  return new Set(rows.map((r) => r.hostId));
}

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
      avatarUrl: users.avatarUrl,
      bio: hostProfiles.bio,
      gallery: hostProfiles.gallery,
      ratePerMinutePaise: hostProfiles.ratePerMinutePaise,
      voiceRatePerMinutePaise: hostProfiles.voiceRatePerMinutePaise,
      messageRatePaise: hostProfiles.messageRatePaise,
      lifetimeEarnedBeans: hostWallets.lifetimeEarnedBeans,
    })
    .from(users)
    .innerJoin(hostProfiles, eq(hostProfiles.userId, users.id))
    .innerJoin(hostWallets, eq(hostWallets.hostId, users.id))
    .where(and(...conditions));

  const onlineIds = new Set(listOnlineHostIds());
  const [ratings, galleryCounts, busyIds] = await Promise.all([
    getHostRatingSummaries(rows.map((r) => r.id)),
    getGalleryCounts(rows.map((r) => r.id)),
    getBusyHostIds(rows.map((r) => r.id)),
  ]);
  let hosts: HostListItem[] = rows.map((r) => {
    const level = levelForLifetimeBeans(r.lifetimeEarnedBeans);
    const max = pricesForLevel(level);
    return {
      id: r.id,
      name: r.name,
      avatarUrl: r.avatarUrl,
      bio: r.bio,
      gallery: r.gallery,
      level,
      ratePerMinutePaise: effectiveRate(r.ratePerMinutePaise, max.videoRatePerMinutePaise),
      voiceRatePerMinutePaise: effectiveRate(r.voiceRatePerMinutePaise, max.voiceRatePerMinutePaise),
      messageRatePaise: effectiveRate(r.messageRatePaise, max.messageRatePaise),
      isOnline: onlineIds.has(r.id),
      isBusy: busyIds.has(r.id),
      rating: ratings.get(r.id) ?? { average: null, count: 0 },
      galleryCount: galleryCounts.get(r.id) ?? 0,
    };
  });

  if (params.onlineOnly) {
    hosts = hosts.filter((h) => h.isOnline);
  }

  // Presence/ratings are merged in above rather than queried in SQL, so
  // sorting on either — or on anything else merged in after the query —
  // has to happen here in application code rather than as a SQL ORDER BY.
  if (params.sort === "rate_asc") {
    hosts.sort((a, b) => a.ratePerMinutePaise - b.ratePerMinutePaise);
  } else if (params.sort === "rate_desc") {
    hosts.sort((a, b) => b.ratePerMinutePaise - a.ratePerMinutePaise);
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
      avatarUrl: users.avatarUrl,
      dob: users.dob,
      bio: hostProfiles.bio,
      gallery: hostProfiles.gallery,
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
  const prices = await getHostEffectivePrices(hostId);

  return {
    ...publicFields,
    level: prices.level,
    ratePerMinutePaise: prices.videoRatePerMinutePaise,
    voiceRatePerMinutePaise: prices.voiceRatePerMinutePaise,
    messageRatePaise: prices.messageRatePaise,
    age: ageFromDob(dob),
    isOnline: listOnlineHostIds().includes(hostId),
    isBusy: (await getBusyHostIds([hostId])).has(hostId),
    rating: await getHostRatingSummary(hostId),
    followerCount: Number(followerCount),
    isFollowing: Number(isFollowingCount) > 0,
  };
}

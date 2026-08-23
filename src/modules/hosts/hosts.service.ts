import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, users } from "../../db/schema";
import { listOnlineHostIds } from "./presence.store";

export type HostListSort = "rate_asc" | "rate_desc" | "online_first";

export type HostListParams = {
  onlineOnly: boolean;
  sort?: HostListSort;
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
};

export async function listHosts(
  params: HostListParams,
): Promise<{ hosts: HostListItem[]; total: number; page: number; pageSize: number }> {
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
    .where(and(eq(users.role, "host"), eq(users.status, "active")));

  const onlineIds = new Set(listOnlineHostIds());
  let hosts: HostListItem[] = rows.map((r) => ({ ...r, isOnline: onlineIds.has(r.id) }));

  if (params.onlineOnly) {
    hosts = hosts.filter((h) => h.isOnline);
  }

  // Presence lives outside Postgres (see presence.store.ts), so sorting on
  // it — or on anything merged in after the query — has to happen here in
  // application code rather than as a SQL ORDER BY.
  if (params.sort === "rate_asc") {
    hosts.sort((a, b) => (a.ratePerMinutePaise ?? Infinity) - (b.ratePerMinutePaise ?? Infinity));
  } else if (params.sort === "rate_desc") {
    hosts.sort((a, b) => (b.ratePerMinutePaise ?? -Infinity) - (a.ratePerMinutePaise ?? -Infinity));
  } else if (params.sort === "online_first") {
    hosts.sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
  }

  const total = hosts.length;
  const start = (params.page - 1) * params.pageSize;
  const paged = hosts.slice(start, start + params.pageSize);

  return { hosts: paged, total, page: params.page, pageSize: params.pageSize };
}

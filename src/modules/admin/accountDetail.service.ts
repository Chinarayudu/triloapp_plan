import { desc, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  calls,
  chatConversations,
  giftTransactions,
  hostProfiles,
  loginEvents,
  moderationReports,
  users,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { TICK_INTERVAL_MS } from "../calls/calls.service";
import { isOnline } from "../hosts/presence.store";
import { getUserById } from "../users/users.service";

type ActivityItem = { type: "call" | "gift" | "chat"; reference: string; when: Date };

// General admin roster (BR-ADM-01 dashboard/list screens) — separate from
// hosts.service.ts's listHosts, which is the public discovery endpoint
// (online/active hosts only, no KYC or status visibility). "Last active"
// is derived from the most recent login_events row (Phase 11's fraud
// tracking) — the only login history this codebase keeps; there's no
// separate session-heartbeat table.
export async function listAccountsForAdmin(role: "user" | "host") {
  const accounts = await db
    .select({
      id: users.id,
      phone: users.phone,
      email: users.email,
      name: users.name,
      status: users.status,
      kycStatus: users.kycStatus,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, role))
    .orderBy(desc(users.createdAt));

  const lastLogins = await db
    .select({ userId: loginEvents.userId, lastActive: sql<Date>`max(${loginEvents.createdAt})` })
    .from(loginEvents)
    .groupBy(loginEvents.userId);
  const lastActiveByUserId = new Map(lastLogins.map((row) => [row.userId, row.lastActive]));

  return accounts.map((account) => ({ ...account, lastActive: lastActiveByUserId.get(account.id) ?? null }));
}

// Last N calls/gifts/chats involving this account, from either side —
// merged into one feed sorted by recency, matching the admin design's
// single "Activity" table rather than three separate ones.
async function getRecentActivity(accountId: string, limit: number): Promise<ActivityItem[]> {
  const callRows = await db
    .select({
      userId: calls.userId,
      hostId: calls.hostId,
      tickCount: calls.tickCount,
      updatedAt: calls.updatedAt,
    })
    .from(calls)
    .where(or(eq(calls.userId, accountId), eq(calls.hostId, accountId)))
    .orderBy(desc(calls.updatedAt))
    .limit(limit);

  const giftRows = await db
    .select({
      senderId: giftTransactions.senderId,
      recipientId: giftTransactions.recipientId,
      beansCredited: giftTransactions.beansCredited,
      createdAt: giftTransactions.createdAt,
    })
    .from(giftTransactions)
    .where(or(eq(giftTransactions.senderId, accountId), eq(giftTransactions.recipientId, accountId)))
    .orderBy(desc(giftTransactions.createdAt))
    .limit(limit);

  const chatRows = await db
    .select({
      userId: chatConversations.userId,
      hostId: chatConversations.hostId,
      lastMessageAt: chatConversations.lastMessageAt,
      createdAt: chatConversations.createdAt,
    })
    .from(chatConversations)
    .where(or(eq(chatConversations.userId, accountId), eq(chatConversations.hostId, accountId)))
    .orderBy(desc(chatConversations.lastMessageAt))
    .limit(limit);

  const otherPartyId = (a: string, b: string) => (a === accountId ? b : a);

  const items: ActivityItem[] = [
    ...callRows.map((c) => ({
      type: "call" as const,
      reference: `${otherPartyId(c.userId, c.hostId)} · ${Math.round((c.tickCount * (TICK_INTERVAL_MS / 1000)) / 60)} min`,
      when: c.updatedAt,
    })),
    ...giftRows.map((g) => ({
      type: "gift" as const,
      reference: `${otherPartyId(g.senderId, g.recipientId)} · ${g.beansCredited} beans`,
      when: g.createdAt,
    })),
    ...chatRows.map((c) => ({
      type: "chat" as const,
      reference: otherPartyId(c.userId, c.hostId),
      when: c.lastMessageAt ?? c.createdAt,
    })),
  ];

  return items.sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, limit);
}

// expectedRole keeps /admin/users/:id and /admin/hosts/:id from crossing
// into each other's roster — without this check, either endpoint would
// happily return an account of the wrong role, which is only cosmetically
// wrong (both are gated by the same moderation permission) but breaks the
// "Users roster" / "Hosts roster" screens the admin design keeps separate.
export async function getAccountDetailForAdmin(accountId: string, expectedRole: "user" | "host") {
  const user = await getUserById(accountId);
  if (!user || user.role !== expectedRole) throw new AppError(404, "Account not found");

  const hostProfile =
    user.role === "host" ? (await db.select().from(hostProfiles).where(eq(hostProfiles.userId, accountId)).limit(1))[0] : undefined;

  const reportsAgainstAccount = await db
    .select()
    .from(moderationReports)
    .where(eq(moderationReports.targetId, accountId))
    .orderBy(desc(moderationReports.createdAt))
    .limit(20);

  return {
    user,
    hostProfile,
    isOnline: user.role === "host" ? isOnline(accountId) : undefined,
    activity: await getRecentActivity(accountId, 20),
    reportsAgainstAccount,
  };
}

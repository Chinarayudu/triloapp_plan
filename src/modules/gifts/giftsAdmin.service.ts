import { and, count, desc, eq, gte, lt, SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { giftRequests, giftTransactions, gifts, users } from "../../db/schema";
import { dayRangeInTimeZone } from "../../lib/dayBounds";

// Admin Gift Activity screen.

const sender = alias(users, "gift_sender");
const recipient = alias(users, "gift_recipient");

export type GiftTransactionQuery = {
  context?: "call" | "live" | "chat";
  hostId?: string;
  userId?: string;
  from?: string;
  to?: string;
  tz: string;
  page: number;
  pageSize: number;
};

export async function listGiftTransactionsForAdmin(query: GiftTransactionQuery) {
  const conditions: SQL[] = [];
  if (query.context) conditions.push(eq(giftTransactions.context, query.context));
  if (query.hostId) conditions.push(eq(giftTransactions.recipientId, query.hostId));
  if (query.userId) conditions.push(eq(giftTransactions.senderId, query.userId));
  if (query.from) conditions.push(gte(giftTransactions.createdAt, dayRangeInTimeZone(query.from, query.tz).start));
  if (query.to) conditions.push(lt(giftTransactions.createdAt, dayRangeInTimeZone(query.to, query.tz).end));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ tx: giftTransactions, giftName: gifts.name, senderName: sender.name, hostName: recipient.name })
      .from(giftTransactions)
      .innerJoin(gifts, eq(gifts.id, giftTransactions.giftId))
      .innerJoin(sender, eq(sender.id, giftTransactions.senderId))
      .innerJoin(recipient, eq(recipient.id, giftTransactions.recipientId))
      .where(where)
      .orderBy(desc(giftTransactions.createdAt), desc(giftTransactions.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(giftTransactions).where(where),
  ]);

  return {
    transactions: rows.map(({ tx, giftName, senderName, hostName }) => ({
      id: tx.id,
      giftId: tx.giftId,
      giftName,
      // What the user paid, as it was at the time.
      pricePaise: tx.pricePaiseSnapshot,
      beans: tx.beansCredited,
      senderId: tx.senderId,
      senderName: senderName ?? "Unknown",
      hostId: tx.recipientId,
      hostName: hostName ?? "Unknown",
      context: tx.context,
      contextId: tx.contextId,
      createdAt: tx.createdAt,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.page * query.pageSize < total,
  };
}

const requestHost = alias(users, "request_host");
const requestUser = alias(users, "request_user");

export type GiftRequestQuery = {
  status?: "pending" | "accepted" | "declined";
  hostId?: string;
  page: number;
  pageSize: number;
};

export async function listGiftRequestsForAdmin(query: GiftRequestQuery) {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(giftRequests.status, query.status));
  if (query.hostId) conditions.push(eq(giftRequests.hostId, query.hostId));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ request: giftRequests, hostName: requestHost.name, userName: requestUser.name, suggestedGiftName: gifts.name })
      .from(giftRequests)
      .innerJoin(requestHost, eq(requestHost.id, giftRequests.hostId))
      .innerJoin(requestUser, eq(requestUser.id, giftRequests.userId))
      .leftJoin(gifts, eq(gifts.id, giftRequests.suggestedGiftId))
      .where(where)
      .orderBy(desc(giftRequests.createdAt), desc(giftRequests.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(giftRequests).where(where),
  ]);

  return {
    requests: rows.map(({ request, hostName, userName, suggestedGiftName }) => ({
      id: request.id,
      hostId: request.hostId,
      hostName: hostName ?? "Unknown",
      userId: request.userId,
      userName: userName ?? "Unknown",
      suggestedGiftId: request.suggestedGiftId,
      suggestedGiftName,
      note: request.note,
      status: request.status,
      createdAt: request.createdAt,
      respondedAt: request.respondedAt,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: query.page * query.pageSize < total,
  };
}

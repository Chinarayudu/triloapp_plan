import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../../db/client";
import { calls, chatConversations, chatMessages, giftTransactions, gifts, liveBroadcasts, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { chatMediaUrl } from "../chat/chat.service";
import { getReportById } from "./moderation.service";

// Admin moderation "Chat between them" — the private chat between the person
// who reported and the account they reported. Reading it is audit-logged by
// the route, since admins are reading private messages.

const MAX_MESSAGES = 200;

// Which account a report is about, whatever was reported.
async function reportedAccountId(report: NonNullable<Awaited<ReturnType<typeof getReportById>>>): Promise<string | null> {
  switch (report.targetType) {
    case "user":
    case "host":
      return report.targetId;
    case "chat_message": {
      const [message] = await db.select({ senderId: chatMessages.senderId }).from(chatMessages).where(eq(chatMessages.id, report.targetId));
      return message?.senderId ?? null;
    }
    case "call": {
      const [call] = await db.select().from(calls).where(eq(calls.id, report.targetId));
      if (!call) return null;
      return call.userId === report.reporterId ? call.hostId : call.userId;
    }
    case "live_broadcast": {
      const [broadcast] = await db.select({ hostId: liveBroadcasts.hostId }).from(liveBroadcasts).where(eq(liveBroadcasts.id, report.targetId));
      return broadcast?.hostId ?? null;
    }
  }
}

export async function getReportConversation(reportId: string) {
  const report = await getReportById(reportId);
  if (!report) throw new AppError(404, "Report not found");

  const otherId = await reportedAccountId(report);
  // Self-filed automated reports (capture escalation, blocked photo) have no
  // second person, so there's no conversation to show.
  if (!otherId || otherId === report.reporterId) return { reportId, conversationId: null, messages: [] };

  const [conversation] = await db
    .select()
    .from(chatConversations)
    .where(
      // A conversation is always (user, host) — the reporter may be either side.
      or(
        and(eq(chatConversations.userId, report.reporterId), eq(chatConversations.hostId, otherId)),
        and(eq(chatConversations.userId, otherId), eq(chatConversations.hostId, report.reporterId)),
      ),
    )
    .limit(1);
  if (!conversation) return { reportId, conversationId: null, messages: [] };

  const rows = await db
    .select({
      message: chatMessages,
      senderName: users.name,
      senderRole: users.role,
      giftId: gifts.id,
      giftName: gifts.name,
      giftIconUrl: gifts.iconUrl,
    })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.senderId))
    .leftJoin(giftTransactions, eq(giftTransactions.id, chatMessages.giftTransactionId))
    .leftJoin(gifts, eq(gifts.id, giftTransactions.giftId))
    .where(eq(chatMessages.conversationId, conversation.id))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(MAX_MESSAGES);

  // Most recent 200, shown oldest first.
  rows.reverse();
  const messages = [];
  for (const r of rows) {
    messages.push({
      id: r.message.id,
      senderId: r.message.senderId,
      senderName: r.senderName ?? "Unknown",
      senderRole: r.senderRole,
      type: r.message.type,
      content: r.message.content,
      mediaUrl: await chatMediaUrl(r.message),
      gift: r.message.type === "gift" && r.giftId ? { id: r.giftId, name: r.giftName, iconUrl: r.giftIconUrl } : null,
      createdAt: r.message.createdAt,
    });
  }
  return { reportId, conversationId: conversation.id, messages };
}

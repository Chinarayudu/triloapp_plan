import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { broadcastMessages, users } from "../../db/schema";
import { sendPushNotification } from "../../lib/push";
import { emitToUser, isUserConnected } from "../../realtime/socket";

type BroadcastRecipients = (typeof broadcastMessages.$inferSelect)["recipients"];

export async function listBroadcastMessages() {
  return db
    .select({
      id: broadcastMessages.id,
      title: broadcastMessages.title,
      message: broadcastMessages.message,
      recipients: broadcastMessages.recipients,
      sentByAdminId: broadcastMessages.sentByAdminId,
      sentByName: users.name,
      createdAt: broadcastMessages.createdAt,
    })
    .from(broadcastMessages)
    .innerJoin(users, eq(users.id, broadcastMessages.sentByAdminId))
    .orderBy(desc(broadcastMessages.createdAt));
}

// Delivered the same way as every other notification in this codebase:
// a socket event to whoever's connected right now, a push fallback for
// whoever isn't. A straightforward per-recipient loop, no queue — there's
// no measured reason yet to need one (dev-standards §10 "correctness
// first, then performance, and only with a reason").
export async function sendBroadcastMessage(
  adminId: string,
  title: string,
  message: string,
  recipients: BroadcastRecipients,
): Promise<{ id: string; recipientCount: number }> {
  const [record] = await db.insert(broadcastMessages).values({ title, message, recipients, sentByAdminId: adminId }).returning();

  const roles = recipients === "all" ? (["user", "host"] as const) : recipients === "all_users" ? (["user"] as const) : (["host"] as const);
  const recipientRows = await db.select({ id: users.id }).from(users).where(inArray(users.role, roles));

  for (const recipient of recipientRows) {
    emitToUser(recipient.id, "broadcast:message", { id: record.id, title, message });
    if (!(await isUserConnected(recipient.id))) {
      void sendPushNotification(recipient.id, title, message);
    }
  }

  return { id: record.id, recipientCount: recipientRows.length };
}

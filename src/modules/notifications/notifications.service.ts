import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { notifications } from "../../db/schema";
import { emitToUser } from "../../realtime/socket";

type Notification = typeof notifications.$inferSelect;
type NotificationType = Notification["type"];

// Called alongside the existing transient socket emit for gifts/withdrawals/
// missed calls, not instead of it — this is the durable record a
// notification-center screen reads later; the socket event is still what
// makes a badge update live right now.
export async function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
): Promise<Notification> {
  const [notification] = await db.insert(notifications).values({ userId, type, title, body }).returning();
  emitToUser(userId, "notification:new", notification);
  return notification;
}

export async function listNotifications(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ notifications: Notification[]; total: number; page: number; pageSize: number }> {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt));
  const start = (page - 1) * pageSize;
  return { notifications: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db.update(notifications).set({ read: true }).where(eq(notifications.userId, userId));
}

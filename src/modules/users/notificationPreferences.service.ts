import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { notificationPreferences } from "../../db/schema";

type PreferencesUpdate = Partial<Omit<typeof notificationPreferences.$inferInsert, "userId" | "updatedAt">>;

// A row is created at signup (users.service.ts's createUser) for every
// account, same convention as the wallet row — this lazy-create is a
// fallback for any account that predates this table, not the primary path.
export async function getPreferences(userId: string) {
  const [existing] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(notificationPreferences).values({ userId }).returning();
  return created;
}

export async function updatePreferences(userId: string, updates: PreferencesUpdate) {
  await getPreferences(userId); // ensures a row exists to update
  const [updated] = await db
    .update(notificationPreferences)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(notificationPreferences.userId, userId))
    .returning();
  return updated;
}

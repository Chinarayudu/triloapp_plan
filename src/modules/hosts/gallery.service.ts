import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostGalleryItems, users } from "../../db/schema";
import { AppError } from "../../lib/errors";

type GalleryItem = typeof hostGalleryItems.$inferSelect;

export async function listGalleryItems(hostId: string): Promise<GalleryItem[]> {
  return db.select().from(hostGalleryItems).where(eq(hostGalleryItems.hostId, hostId)).orderBy(desc(hostGalleryItems.createdAt));
}

// Creator Profile screen's Gallery tab — any viewer, but only for an active
// host, same visibility rule as GET /hosts/:hostId (a suspended host's media
// shouldn't stay browsable just because the id is known).
export async function listPublicGalleryItems(hostId: string): Promise<GalleryItem[]> {
  const [host] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, hostId), eq(users.role, "host"), eq(users.status, "active")))
    .limit(1);
  if (!host) throw new AppError(404, "Host not found");
  return listGalleryItems(hostId);
}

export async function addGalleryItem(
  hostId: string,
  mediaType: GalleryItem["mediaType"],
  url: string,
  durationSeconds?: number,
): Promise<GalleryItem> {
  const [item] = await db.insert(hostGalleryItems).values({ hostId, mediaType, url, durationSeconds }).returning();
  return item;
}

// Scoped to the caller's own items only — the id alone isn't enough proof
// of ownership, same reasoning as every other "delete my own X" endpoint
// in this codebase.
export async function deleteOwnGalleryItem(hostId: string, itemId: string): Promise<void> {
  const [deleted] = await db
    .delete(hostGalleryItems)
    .where(and(eq(hostGalleryItems.id, itemId), eq(hostGalleryItems.hostId, hostId)))
    .returning({ id: hostGalleryItems.id });
  if (!deleted) throw new AppError(404, "Gallery item not found");
}

// Admin moderation — any host's item, not scoped to a caller. Returns the
// deleted row so admin.routes.ts can audit-log which host it belonged to.
export async function adminDeleteGalleryItem(itemId: string): Promise<GalleryItem> {
  const [deleted] = await db.delete(hostGalleryItems).where(eq(hostGalleryItems.id, itemId)).returning();
  if (!deleted) throw new AppError(404, "Gallery item not found");
  return deleted;
}

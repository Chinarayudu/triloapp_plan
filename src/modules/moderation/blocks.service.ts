import { and, eq, or } from "drizzle-orm";
import { db } from "../../db/client";
import { userBlocks, users } from "../../db/schema";
import { AppError } from "../../lib/errors";

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw new AppError(400, "Cannot block yourself");

  const [target] = await db.select().from(users).where(eq(users.id, blockedId)).limit(1);
  if (!target) throw new AppError(404, "User not found");

  const [existing] = await db
    .select()
    .from(userBlocks)
    .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
    .limit(1);
  if (existing) return existing;

  const [block] = await db.insert(userBlocks).values({ blockerId, blockedId }).returning();
  return block;
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await db
    .delete(userBlocks)
    .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)));
}

export async function listBlocked(blockerId: string) {
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role, blockedAt: userBlocks.createdAt })
    .from(userBlocks)
    .innerJoin(users, eq(users.id, userBlocks.blockedId))
    .where(eq(userBlocks.blockerId, blockerId));
  return rows;
}

// Directional both ways — a call/message must be rejected whichever side
// did the blocking (calls.service.ts, chat.service.ts), not just when the
// current actor is the one who blocked.
export async function areBlocked(a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
        and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

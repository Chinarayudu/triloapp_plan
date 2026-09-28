import { desc, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { callMediaConfigs } from "../../db/schema";
import { generateAgoraToken } from "../../lib/agoraToken";
import { writeAuditLog } from "../../lib/auditLog";
import { getIceServers, IceServer } from "../../lib/iceServers";

export type CallMediaProvider = (typeof callMediaConfigs.$inferSelect)["provider"];

// Exactly one of agoraToken / iceServers is set, depending on the call's
// snapshotted provider — the apps branch on mediaProvider to pick which one to use.
export type CallMediaCredentials = {
  mediaProvider: CallMediaProvider;
  agoraToken: string | null;
  iceServers: IceServer[] | null;
};

// No row at all = "agora", the provider every call used before this switch
// existed — so a database that was never configured keeps behaving exactly
// as it always did, rather than refusing to place calls.
export async function getCurrentCallMediaProvider(): Promise<CallMediaProvider> {
  const [row] = await db
    .select()
    .from(callMediaConfigs)
    .where(lte(callMediaConfigs.effectiveFrom, new Date()))
    .orderBy(desc(callMediaConfigs.effectiveFrom))
    .limit(1);
  return row?.provider ?? "agora";
}

export async function listCallMediaConfigs() {
  return db.select().from(callMediaConfigs).orderBy(desc(callMediaConfigs.effectiveFrom));
}

// Takes effect for the next call placed; ringing/ongoing calls keep the
// provider they started with (calls.mediaProvider).
export async function setCallMediaProvider(adminId: string, provider: CallMediaProvider) {
  const previous = await getCurrentCallMediaProvider();
  // effectiveFrom stamped with this server's clock, not the database's now() default:
  // getCurrentCallMediaProvider compares against this server's clock, and any DB clock
  // skew would otherwise leave a just-made switch looking "not yet effective" briefly.
  const [row] = await db.insert(callMediaConfigs).values({ provider, effectiveFrom: new Date() }).returning();
  await writeAuditLog(adminId, "config.call_media.create", "call_media_config", row.id, { previous, new: provider });
  return row;
}

export async function getCallMediaCredentials(
  mediaProvider: CallMediaProvider,
  channelName: string,
  uid: string,
): Promise<CallMediaCredentials> {
  if (mediaProvider === "agora") {
    return { mediaProvider, agoraToken: generateAgoraToken(channelName, uid), iceServers: null };
  }
  return { mediaProvider, agoraToken: null, iceServers: await getIceServers() };
}

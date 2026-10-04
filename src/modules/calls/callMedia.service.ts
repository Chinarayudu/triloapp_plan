import { desc, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { callMediaConfigs, calls } from "../../db/schema";
import { closeAgoraChannel } from "../../lib/agoraChannel";
import { generateAgoraToken } from "../../lib/agoraToken";
import { writeAuditLog } from "../../lib/auditLog";
import { getIceServers, IceServer } from "../../lib/iceServers";
import { logger } from "../../lib/logger";

// What a call is actually carried by — never "auto".
export type CallMediaProvider = (typeof calls.$inferSelect)["mediaProvider"];
// What the admin switch is set to.
export type CallMediaMode = (typeof callMediaConfigs.$inferSelect)["provider"];

export type CallMediaConfig = { mode: CallMediaMode; autoP2pPercent: number; agoraKickOnEnd: boolean };

// Exactly one of agoraToken / iceServers is set, depending on the call's
// snapshotted provider — the apps branch on mediaProvider to pick which one to use.
// agoraFallbackAllowed: a p2p call that can't connect may switch to Agora
// (POST /calls/:id/media-fallback).
export type CallMediaCredentials = {
  mediaProvider: CallMediaProvider;
  agoraToken: string | null;
  iceServers: IceServer[] | null;
  agoraFallbackAllowed: boolean;
};

// No row at all = plain Agora with nothing else switched on — exactly how
// every call behaved before this switch existed, so a database that was never
// configured keeps behaving as it always did.
const DEFAULT_CONFIG: CallMediaConfig = { mode: "agora", autoP2pPercent: 100, agoraKickOnEnd: false };

export async function getCurrentCallMediaConfig(): Promise<CallMediaConfig> {
  const [row] = await db
    .select()
    .from(callMediaConfigs)
    .where(lte(callMediaConfigs.effectiveFrom, new Date()))
    .orderBy(desc(callMediaConfigs.effectiveFrom))
    .limit(1);
  if (!row) return DEFAULT_CONFIG;
  return { mode: row.provider, autoP2pPercent: row.autoP2pPercent, agoraKickOnEnd: row.agoraKickOnEnd };
}

export async function listCallMediaConfigs() {
  return db.select().from(callMediaConfigs).orderBy(desc(callMediaConfigs.effectiveFrom));
}

// Takes effect for the next call placed; ringing/ongoing calls keep the
// provider they started with (calls.mediaProvider).
export async function setCallMediaConfig(adminId: string, config: CallMediaConfig) {
  const previous = await getCurrentCallMediaConfig();
  // effectiveFrom stamped with this server's clock, not the database's now() default:
  // getCurrentCallMediaConfig compares against this server's clock, and any DB clock
  // skew would otherwise leave a just-made switch looking "not yet effective" briefly.
  const [row] = await db
    .insert(callMediaConfigs)
    .values({
      provider: config.mode,
      autoP2pPercent: config.autoP2pPercent,
      agoraKickOnEnd: config.agoraKickOnEnd,
      effectiveFrom: new Date(),
    })
    .returning();
  await writeAuditLog(adminId, "config.call_media.create", "call_media_config", row.id, { previous, new: config });
  return row;
}

// Which provider a new call starts on. `roll` is a number in [0, 100) — passed
// in rather than drawn here so the choice is easy to see and to test.
export function chooseCallMedia(
  config: CallMediaConfig,
  roll: number,
): { mediaProvider: CallMediaProvider; agoraFallbackAllowed: boolean } {
  if (config.mode === "agora") return { mediaProvider: "agora", agoraFallbackAllowed: false };
  if (config.mode === "p2p") return { mediaProvider: "p2p", agoraFallbackAllowed: false };
  if (roll < config.autoP2pPercent) return { mediaProvider: "p2p", agoraFallbackAllowed: true };
  return { mediaProvider: "agora", agoraFallbackAllowed: false };
}

export async function getCallMediaCredentials(
  call: { mediaProvider: CallMediaProvider; agoraFallbackAllowed: boolean },
  channelName: string,
  uid: string,
): Promise<CallMediaCredentials> {
  const { mediaProvider, agoraFallbackAllowed } = call;
  if (mediaProvider === "agora") {
    return { mediaProvider, agoraToken: generateAgoraToken(channelName, uid), iceServers: null, agoraFallbackAllowed };
  }
  return { mediaProvider, agoraToken: null, iceServers: await getIceServers(), agoraFallbackAllowed };
}

// Run wherever a connected call ends. Never throws: the call has already
// ended and billing has stopped — a failed Agora API call must not undo or
// fail that, it's logged loudly instead.
export async function closeCallChannelIfEnabled(channelName: string, mediaProvider: CallMediaProvider): Promise<void> {
  if (mediaProvider !== "agora") return;
  try {
    const config = await getCurrentCallMediaConfig();
    if (!config.agoraKickOnEnd) return;
    await closeAgoraChannel(channelName);
  } catch (err) {
    logger.error({ err, channelName }, "Could not close the Agora channel of an ended call");
  }
}

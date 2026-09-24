import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, hostWallets } from "../../db/schema";
import { emitToUser } from "../../realtime/socket";

// Host levels (business decision, 2026-09-24): every host starts at Level 1
// and moves up one level per 1,00,000 lifetime-earned beans, up to Level 20.
// Each level's prices are the host's MAXIMUM — a host may set a lower rate,
// and a host who hasn't set one charges exactly the level price, so their
// prices rise automatically on level-up.
//
// Level 1: voice ₹20/min, video ₹30/min, message ₹5; each level adds ₹20 to all three.
export const MAX_HOST_LEVEL = 20;
export const BEANS_PER_LEVEL = 100_000;
const LEVEL_STEP_PAISE = 2000;
const LEVEL_1_VOICE_PAISE = 2000;
const LEVEL_1_VIDEO_PAISE = 3000;
const LEVEL_1_MESSAGE_PAISE = 500;

export type LevelPrices = {
  voiceRatePerMinutePaise: number;
  videoRatePerMinutePaise: number;
  messageRatePaise: number;
};

export function levelForLifetimeBeans(lifetimeEarnedBeans: number): number {
  return Math.min(MAX_HOST_LEVEL, 1 + Math.floor(lifetimeEarnedBeans / BEANS_PER_LEVEL));
}

export function pricesForLevel(level: number): LevelPrices {
  const step = (level - 1) * LEVEL_STEP_PAISE;
  return {
    voiceRatePerMinutePaise: LEVEL_1_VOICE_PAISE + step,
    videoRatePerMinutePaise: LEVEL_1_VIDEO_PAISE + step,
    messageRatePaise: LEVEL_1_MESSAGE_PAISE + step,
  };
}

// What a user is actually charged: the host's own rate if set, never above
// the level's maximum. A rate set while at a higher cap can't happen (levels
// never go down), but a pre-levels rate can exceed Level 1's cap — this clamps it.
export function effectiveRate(hostSetRate: number | null, levelMax: number): number {
  return hostSetRate === null ? levelMax : Math.min(hostSetRate, levelMax);
}

export async function getHostLifetimeEarnedBeans(hostId: string): Promise<number> {
  const [row] = await db
    .select({ lifetimeEarnedBeans: hostWallets.lifetimeEarnedBeans })
    .from(hostWallets)
    .where(eq(hostWallets.hostId, hostId))
    .limit(1);
  if (!row) throw new Error(`No host wallet row for host ${hostId}`);
  return row.lifetimeEarnedBeans;
}

export async function getHostLevelPrices(hostId: string): Promise<{ level: number; max: LevelPrices }> {
  const level = levelForLifetimeBeans(await getHostLifetimeEarnedBeans(hostId));
  return { level, max: pricesForLevel(level) };
}

// The prices a user sees and pays for this host right now.
export async function getHostEffectivePrices(hostId: string): Promise<{ level: number } & LevelPrices> {
  const { level, max } = await getHostLevelPrices(hostId);
  const [profile] = await db
    .select({
      voiceRatePerMinutePaise: hostProfiles.voiceRatePerMinutePaise,
      ratePerMinutePaise: hostProfiles.ratePerMinutePaise,
      messageRatePaise: hostProfiles.messageRatePaise,
    })
    .from(hostProfiles)
    .where(eq(hostProfiles.userId, hostId))
    .limit(1);
  if (!profile) throw new Error(`No host profile row for host ${hostId}`);
  return {
    level,
    voiceRatePerMinutePaise: effectiveRate(profile.voiceRatePerMinutePaise, max.voiceRatePerMinutePaise),
    videoRatePerMinutePaise: effectiveRate(profile.ratePerMinutePaise, max.videoRatePerMinutePaise),
    messageRatePaise: effectiveRate(profile.messageRatePaise, max.messageRatePaise),
  };
}

// Host app's Level screen.
export async function getHostLevelSummary(hostId: string) {
  const lifetimeEarnedBeans = await getHostLifetimeEarnedBeans(hostId);
  const level = levelForLifetimeBeans(lifetimeEarnedBeans);
  const isMaxLevel = level === MAX_HOST_LEVEL;
  const effective = await getHostEffectivePrices(hostId);
  return {
    level,
    maxLevel: MAX_HOST_LEVEL,
    lifetimeEarnedBeans,
    beansPerLevel: BEANS_PER_LEVEL,
    // Beans still needed to reach the next level; null at Level 20.
    beansToNextLevel: isMaxLevel ? null : level * BEANS_PER_LEVEL - lifetimeEarnedBeans,
    maxPrices: pricesForLevel(level),
    currentPrices: {
      voiceRatePerMinutePaise: effective.voiceRatePerMinutePaise,
      videoRatePerMinutePaise: effective.videoRatePerMinutePaise,
      messageRatePaise: effective.messageRatePaise,
    },
    nextLevelMaxPrices: isMaxLevel ? null : pricesForLevel(level + 1),
    levels: Array.from({ length: MAX_HOST_LEVEL }, (_, i) => ({
      level: i + 1,
      requiredLifetimeBeans: i * BEANS_PER_LEVEL,
      ...pricesForLevel(i + 1),
    })),
  };
}

// Called by each earnings path AFTER its transaction commits (never inside
// it — a rolled-back transfer must not announce a level-up).
export function notifyIfLevelledUp(hostId: string, lifetimeBefore: number, lifetimeAfter: number): void {
  const before = levelForLifetimeBeans(lifetimeBefore);
  const after = levelForLifetimeBeans(lifetimeAfter);
  if (after <= before) return;
  emitToUser(hostId, "host:level-up", { level: after, previousLevel: before, maxPrices: pricesForLevel(after) });
}

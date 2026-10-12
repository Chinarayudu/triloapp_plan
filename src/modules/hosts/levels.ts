import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { hostProfiles, hostWallets } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { emitToUser } from "../../realtime/socket";

// Host levels (business decision, 2026-09-24): every host starts at Level 1
// and moves up one level per 1,00,000 lifetime-earned beans, up to Level 20.
// A host charges exactly one level's prices — they can't type in their own
// rates (business decision, 2026-10-12). They pick a price level at or below
// the level they've unlocked (host_profiles.price_level); unset means "my
// unlocked level", so their prices rise automatically on level-up.
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

// The level whose prices a host charges. Clamped to the unlocked level even
// though a higher pick is refused when it's set — levels never go down, but
// this keeps the rule in one place.
export function pricedLevel(priceLevel: number | null, unlockedLevel: number): number {
  return priceLevel === null ? unlockedLevel : Math.min(priceLevel, unlockedLevel);
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

async function getHostPriceLevelSetting(hostId: string): Promise<number | null> {
  const [profile] = await db
    .select({ priceLevel: hostProfiles.priceLevel })
    .from(hostProfiles)
    .where(eq(hostProfiles.userId, hostId))
    .limit(1);
  if (!profile) throw new Error(`No host profile row for host ${hostId}`);
  return profile.priceLevel;
}

// The prices a user sees and pays for this host right now. `level` is the
// host's unlocked level (shown on their profile), not the priced one.
export async function getHostEffectivePrices(hostId: string): Promise<{ level: number; pricedLevel: number } & LevelPrices> {
  const level = levelForLifetimeBeans(await getHostLifetimeEarnedBeans(hostId));
  const priced = pricedLevel(await getHostPriceLevelSetting(hostId), level);
  return { level, pricedLevel: priced, ...pricesForLevel(priced) };
}

// PATCH /me/host-profile's priceLevel. null = follow the unlocked level.
export async function setHostPriceLevel(hostId: string, priceLevel: number | null): Promise<void> {
  if (priceLevel !== null) {
    const unlocked = levelForLifetimeBeans(await getHostLifetimeEarnedBeans(hostId));
    if (priceLevel > unlocked) {
      throw new AppError(400, `You can only pick a price level up to Level ${unlocked}, the level you've unlocked`);
    }
  }
  await db.update(hostProfiles).set({ priceLevel, updatedAt: new Date() }).where(eq(hostProfiles.userId, hostId));
}

// Host app's Level screen.
export async function getHostLevelSummary(hostId: string) {
  const lifetimeEarnedBeans = await getHostLifetimeEarnedBeans(hostId);
  const level = levelForLifetimeBeans(lifetimeEarnedBeans);
  const isMaxLevel = level === MAX_HOST_LEVEL;
  const effective = await getHostEffectivePrices(hostId);
  const priceLevel = await getHostPriceLevelSetting(hostId);
  return {
    level,
    // The host's pick (null = "my unlocked level") and the level actually charged.
    priceLevel,
    pricedLevel: effective.pricedLevel,
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
    // unlocked = selectable as a price level; selected = the one being charged.
    levels: Array.from({ length: MAX_HOST_LEVEL }, (_, i) => ({
      level: i + 1,
      requiredLifetimeBeans: i * BEANS_PER_LEVEL,
      ...pricesForLevel(i + 1),
      unlocked: i + 1 <= level,
      selected: i + 1 === effective.pricedLevel,
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

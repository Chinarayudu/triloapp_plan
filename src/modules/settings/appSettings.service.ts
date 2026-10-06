import { desc, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettingsConfigs } from "../../db/schema";
import { writeAuditLog } from "../../lib/auditLog";

// Values the apps and backend used to hard-code, now admin-editable
// (GET/POST /admin/config/app-settings) and read by the apps from GET /config.
export type AppSettings = {
  dailyGoalSeconds: number;
  callQuality: { goodFromSeconds: number; excellentFromSeconds: number };
  messagePrice: { minPaise: number; maxPaise: number };
  liveCommentMaxLength: number;
};

// No row = the values everything used before this table existed: the host
// app's 6-hour goal, calls "good" from 4 minutes and "excellent" over 10
// minutes, the apps' ₹5–₹100 message-price picker, and 2000-character live
// comments — so nothing changes until an admin saves new values.
export const DEFAULT_APP_SETTINGS: AppSettings = {
  dailyGoalSeconds: 6 * 60 * 60,
  callQuality: { goodFromSeconds: 4 * 60, excellentFromSeconds: 10 * 60 + 1 },
  messagePrice: { minPaise: 500, maxPaise: 10_000 },
  liveCommentMaxLength: 2000,
};

export async function getAppSettings(): Promise<AppSettings> {
  const [row] = await db
    .select()
    .from(appSettingsConfigs)
    .where(lte(appSettingsConfigs.effectiveFrom, new Date()))
    .orderBy(desc(appSettingsConfigs.effectiveFrom))
    .limit(1);
  if (!row) return DEFAULT_APP_SETTINGS;
  return {
    dailyGoalSeconds: row.dailyGoalSeconds,
    callQuality: { goodFromSeconds: row.callQualityGoodFromSeconds, excellentFromSeconds: row.callQualityExcellentFromSeconds },
    messagePrice: { minPaise: row.messagePriceMinPaise, maxPaise: row.messagePriceMaxPaise },
    liveCommentMaxLength: row.liveCommentMaxLength,
  };
}

export async function setAppSettings(adminId: string, settings: AppSettings, reason: string | undefined): Promise<AppSettings> {
  const previous = await getAppSettings();
  // Server clock, not the DB default — same reasoning as setCallMediaConfig.
  const [row] = await db
    .insert(appSettingsConfigs)
    .values({
      dailyGoalSeconds: settings.dailyGoalSeconds,
      callQualityGoodFromSeconds: settings.callQuality.goodFromSeconds,
      callQualityExcellentFromSeconds: settings.callQuality.excellentFromSeconds,
      messagePriceMinPaise: settings.messagePrice.minPaise,
      messagePriceMaxPaise: settings.messagePrice.maxPaise,
      liveCommentMaxLength: settings.liveCommentMaxLength,
      effectiveFrom: new Date(),
    })
    .returning();
  await writeAuditLog(adminId, "config.app_settings.create", "app_settings_config", row.id, { before: previous, after: settings, reason });
  return settings;
}

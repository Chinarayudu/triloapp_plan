import { env } from "../config/env";
import { TOKEN_EXPIRY_SECONDS } from "./agoraToken";
import { logger } from "./logger";

// Long enough to outlast any token ever issued for the channel: every token is
// minted no later than the moment the call/broadcast ends, and lives
// TOKEN_EXPIRY_SECONDS. Channels are never reused (call-<id> / live-<id>), so a
// long ban has no downside.
const BAN_MINUTES = Math.ceil(TOKEN_EXPIRY_SECONDS / 60);

// Removes everyone from an Agora channel and stops anyone rejoining it, via
// Agora's "ban user privileges" rule with only `cname` set. Without this a
// call or broadcast ending relies on each app leaving the channel itself —
// an app that doesn't (bug, or a modified client) keeps media flowing on a
// still-valid 4h token, which Agora bills us for.
//
// Throws on any failure; callers decide whether that may fail their flow.
export async function closeAgoraChannel(channelName: string): Promise<void> {
  if (!env.AGORA_APP_ID || !env.AGORA_CUSTOMER_ID || !env.AGORA_CUSTOMER_SECRET) {
    logger.warn({ channelName }, "Agora RESTful credentials not configured — channel not closed");
    return;
  }

  const auth = Buffer.from(`${env.AGORA_CUSTOMER_ID}:${env.AGORA_CUSTOMER_SECRET}`).toString("base64");
  const res = await fetch("https://api.agora.io/dev/v1/kicking-rule", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ appid: env.AGORA_APP_ID, cname: channelName, time: BAN_MINUTES, privileges: ["join_channel"] }),
  });
  if (!res.ok) throw new Error(`Agora kicking-rule API responded ${res.status}: ${await res.text()}`);
}

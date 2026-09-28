import { env } from "../config/env";
import { logger } from "./logger";

// Browser RTCIceServer shape — handed to both apps as-is for `new RTCPeerConnection({ iceServers })`.
export type IceServer = { urls: string | string[]; username?: string; credential?: string };

// STUN only tells each device its own public address — free, and enough for
// the ~80-85% of calls where the two devices can reach each other directly.
const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// Comfortably longer than any real call; credentials only need to outlive
// the call they were issued for.
const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

// Short-lived TURN credentials per call, minted from Cloudflare's TURN API
// (billed per GB relayed, first 1,000 GB/month free). A failure here degrades
// to STUN only rather than failing the call: most calls never need the relay,
// and the ones that do fail visibly ("couldn't connect") — the error is logged
// so a broken TURN key doesn't go unnoticed.
export async function getIceServers(): Promise<IceServer[]> {
  if (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_API_TOKEN) return STUN_ONLY;

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      },
    );
    if (!res.ok) throw new Error(`Cloudflare TURN API responded ${res.status}: ${await res.text()}`);
    // This endpoint returns a single server object; the newer
    // generate-ice-servers variant returns an array. Accept either.
    const body = (await res.json()) as { iceServers: IceServer | IceServer[] };
    const turn = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    return [...STUN_ONLY, ...turn];
  } catch (err) {
    logger.error({ err }, "Could not mint TURN credentials — falling back to STUN only for this call");
    return STUN_ONLY;
  }
}

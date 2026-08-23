import { RtcRole, RtcTokenBuilder } from "agora-token";
import { env } from "../config/env";
import { logger } from "./logger";

const agoraConfigured = Boolean(env.AGORA_APP_ID && env.AGORA_APP_CERTIFICATE);

// Generous headroom for a call's actual duration — we don't know it in
// advance, and a token expiring mid-call would drop the connection.
const TOKEN_EXPIRY_SECONDS = 4 * 60 * 60;

// Token generation is a local HMAC computation (like S3 presigning), not a
// network call — safe to run in every environment. Falls back to a
// clearly-fake stub when Agora isn't configured, same pattern as
// otpSender.ts, so call flows stay buildable/testable without a real
// Agora project.
//
// role defaults to PUBLISHER (both parties publish audio/video on a 1:1
// call) — live broadcasting is the first caller that needs SUBSCRIBER
// (a viewer only receives the host's stream, never publishes).
export function generateAgoraToken(
  channelName: string,
  uid: string,
  role: (typeof RtcRole)[keyof typeof RtcRole] = RtcRole.PUBLISHER,
): string {
  if (!agoraConfigured) {
    logger.warn({ channelName, uid, role }, "Agora not configured — issuing a stub token, not a real one");
    return `stub-agora-token:${channelName}:${uid}`;
  }

  return RtcTokenBuilder.buildTokenWithUserAccount(
    env.AGORA_APP_ID!,
    env.AGORA_APP_CERTIFICATE!,
    channelName,
    uid,
    role,
    TOKEN_EXPIRY_SECONDS,
    TOKEN_EXPIRY_SECONDS,
  );
}

export { RtcRole };

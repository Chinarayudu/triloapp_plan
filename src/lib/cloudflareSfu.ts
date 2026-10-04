import { env } from "../config/env";
import { AppError } from "./errors";

// Cloudflare Realtime SFU (https://developers.cloudflare.com/realtime/sfu/) —
// the "cloudflare" live-broadcast provider. The host's app pushes its
// camera/mic to one SFU session; each viewer's app gets its own session that
// pulls those tracks. The app secret must never reach a client, so every SFU
// call goes through here; the apps only ever see SDP.
//
// Billed per GB the SFU sends out (first 1,000 GB/month free, shared with the
// TURN relay in iceServers.ts) instead of Agora's per-viewer-minute price.

export type SessionDescription = { type: "offer" | "answer"; sdp: string };

type TrackResult = { mid?: string; trackName?: string; errorCode?: string; errorDescription?: string };
type SfuResponse = {
  sessionId?: string;
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: TrackResult[];
  errorCode?: string;
  errorDescription?: string;
};

// The SFU reports some failures with a 200 and an errorCode (top-level or per
// track), so status alone isn't enough to know a call worked.
async function sfuRequest(method: "POST" | "PUT", path: string, body?: unknown): Promise<SfuResponse> {
  if (!env.CLOUDFLARE_REALTIME_APP_ID || !env.CLOUDFLARE_REALTIME_APP_SECRET) {
    throw new AppError(503, "Live video via Cloudflare isn't configured on this server");
  }
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${env.CLOUDFLARE_REALTIME_APP_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_REALTIME_APP_SECRET}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare SFU ${method} ${path} responded ${res.status}: ${text}`);
  const json = (text ? JSON.parse(text) : {}) as SfuResponse;
  const failedTrack = json.tracks?.find((t) => t.errorCode);
  if (json.errorCode || failedTrack) {
    const error = json.errorCode ? json : failedTrack!;
    throw new Error(`Cloudflare SFU ${method} ${path} failed: ${error.errorCode} ${error.errorDescription ?? ""}`);
  }
  return json;
}

export async function createSfuSession(): Promise<string> {
  const res = await sfuRequest("POST", "/sessions/new");
  if (!res.sessionId) throw new Error("Cloudflare SFU created a session without returning its id");
  return res.sessionId;
}

// Host side: the app's offer describes the tracks it's sending (by mid); the
// SFU answers it. trackName is what viewers pull by.
export async function pushTracks(
  sessionId: string,
  offer: SessionDescription,
  tracks: { mid: string; trackName: string }[],
): Promise<SessionDescription> {
  const res = await sfuRequest("POST", `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: offer,
    tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })),
  });
  if (!res.sessionDescription) throw new Error("Cloudflare SFU accepted pushed tracks without an SDP answer");
  return res.sessionDescription;
}

// Viewer side: no offer from the app — the SFU offers the host's tracks, and
// the app's answer goes back through renegotiate() below.
export async function pullTracks(
  sessionId: string,
  fromSessionId: string,
  trackNames: string[],
): Promise<{ offer: SessionDescription | null }> {
  const res = await sfuRequest("POST", `/sessions/${sessionId}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({ location: "remote", sessionId: fromSessionId, trackName })),
  });
  return { offer: res.requiresImmediateRenegotiation && res.sessionDescription ? res.sessionDescription : null };
}

export async function renegotiate(sessionId: string, answer: SessionDescription): Promise<void> {
  await sfuRequest("PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer });
}

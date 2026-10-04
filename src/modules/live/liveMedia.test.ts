import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { registerAndLogin, registerAndLoginAdmin, stubFetch } from "../../test/helpers";

// The test DB is shared by every test file — every test that flips the global
// live media switch puts it back to the plain-Agora default in `finally`.
const AGORA_DEFAULT_LIVE = { provider: "agora", agoraKickOnEnd: false, pauseHiddenVideo: false };

describe("Live: Cloudflare SFU provider and channel close on end", () => {
  const savedEnv = {
    appId: env.CLOUDFLARE_REALTIME_APP_ID,
    secret: env.CLOUDFLARE_REALTIME_APP_SECRET,
    customerId: env.AGORA_CUSTOMER_ID,
    customerSecret: env.AGORA_CUSTOMER_SECRET,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    env.CLOUDFLARE_REALTIME_APP_ID = savedEnv.appId;
    env.CLOUDFLARE_REALTIME_APP_SECRET = savedEnv.secret;
    env.AGORA_CUSTOMER_ID = savedEnv.customerId;
    env.AGORA_CUSTOMER_SECRET = savedEnv.customerSecret;
  });

  it("sets up host publish and viewer subscribe through the SFU without exposing its secret", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const setLiveMedia = (body: object) =>
      request(app).post("/admin/config/live-media").set("Authorization", `Bearer ${admin.accessToken}`).send(body);
    const host = await registerAndLogin(app, "host");
    const viewer = await registerAndLogin(app, "user");
    const outsider = await registerAndLogin(app, "user");

    env.CLOUDFLARE_REALTIME_APP_ID = "cf-app";
    env.CLOUDFLARE_REALTIME_APP_SECRET = "cf-secret";
    let sessions = 0;
    const sfuRequests = stubFetch((url, body) => {
      if (url.endsWith("/sessions/new")) return { sessionId: `session-${++sessions}` };
      const tracks = (body as { tracks?: { location: string }[] })?.tracks;
      if (url.endsWith("/tracks/new") && tracks?.[0].location === "local") {
        return { sessionDescription: { type: "answer", sdp: "sfu-answer" }, tracks: [{ mid: "0", trackName: "video" }] };
      }
      if (url.endsWith("/tracks/new")) {
        return { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "sfu-offer" }, tracks: [] };
      }
      return {};
    });

    try {
      expect((await setLiveMedia({ provider: "cloudflare", pauseHiddenVideo: true })).status).toBe(201);

      const start = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
      expect(start.body).toMatchObject({ mediaProvider: "cloudflare", agoraToken: null, pauseHiddenVideo: true });
      expect(start.body.iceServers.length).toBeGreaterThan(0);
      const broadcastId = start.body.broadcastId as string;

      const join = await request(app).post(`/user/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);
      expect(join.body).toMatchObject({ mediaProvider: "cloudflare", agoraToken: null });

      // Host hasn't published yet — the viewer's app retries.
      const tooEarly = await request(app).post(`/user/live/broadcasts/${broadcastId}/sfu/subscribe`).set("Authorization", `Bearer ${viewer.accessToken}`);
      expect(tooEarly.status).toBe(409);

      const publish = await request(app)
        .post(`/host/live/broadcasts/${broadcastId}/sfu/publish`)
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ sdp: "host-offer", tracks: [{ mid: "0", trackName: "video" }, { mid: "1", trackName: "audio" }] });
      expect(publish.status).toBe(200);
      expect(publish.body).toEqual({ sdp: "sfu-answer" });
      expect(sfuRequests[1].url).toBe("https://rtc.live.cloudflare.com/v1/apps/cf-app/sessions/session-1/tracks/new");
      expect(sfuRequests[1].headers.Authorization).toBe("Bearer cf-secret");
      expect(sfuRequests[1].body).toEqual({
        sessionDescription: { type: "offer", sdp: "host-offer" },
        tracks: [
          { location: "local", mid: "0", trackName: "video" },
          { location: "local", mid: "1", trackName: "audio" },
        ],
      });

      const subscribe = await request(app).post(`/user/live/broadcasts/${broadcastId}/sfu/subscribe`).set("Authorization", `Bearer ${viewer.accessToken}`);
      expect(subscribe.body).toEqual({ sessionId: "session-2", sdp: "sfu-offer" });
      expect(sfuRequests[3].body).toEqual({
        tracks: [
          { location: "remote", sessionId: "session-1", trackName: "video" },
          { location: "remote", sessionId: "session-1", trackName: "audio" },
        ],
      });

      // Someone who hasn't joined can't complete the viewer's session.
      const hijack = await request(app)
        .post(`/user/live/broadcasts/${broadcastId}/sfu/answer`)
        .set("Authorization", `Bearer ${outsider.accessToken}`)
        .send({ sessionId: "session-2", sdp: "x" });
      expect(hijack.status).toBe(403);

      const answer = await request(app)
        .post(`/user/live/broadcasts/${broadcastId}/sfu/answer`)
        .set("Authorization", `Bearer ${viewer.accessToken}`)
        .send({ sessionId: "session-2", sdp: "viewer-answer" });
      expect(answer.status).toBe(204);
      const renegotiate = sfuRequests[sfuRequests.length - 1];
      expect(renegotiate.method).toBe("PUT");
      expect(renegotiate.url).toBe("https://rtc.live.cloudflare.com/v1/apps/cf-app/sessions/session-2/renegotiate");
      expect(renegotiate.body).toEqual({ sessionDescription: { type: "answer", sdp: "viewer-answer" } });

      await request(app).post(`/host/live/broadcasts/${broadcastId}/end`).set("Authorization", `Bearer ${host.accessToken}`);

      // Agora broadcasts are untouched by the SFU endpoints.
      await setLiveMedia({ provider: "agora" });
      const agoraStart = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
      expect(agoraStart.body.mediaProvider).toBe("agora");
      expect(typeof agoraStart.body.agoraToken).toBe("string");
      const wrongProvider = await request(app)
        .post(`/host/live/broadcasts/${agoraStart.body.broadcastId}/sfu/publish`)
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ sdp: "x", tracks: [{ mid: "0", trackName: "video" }] });
      expect(wrongProvider.status).toBe(409);
      await request(app).post(`/host/live/broadcasts/${agoraStart.body.broadcastId}/end`).set("Authorization", `Bearer ${host.accessToken}`);
    } finally {
      await setLiveMedia(AGORA_DEFAULT_LIVE);
    }
  });

  it("bans an Agora broadcast's channel when it ends, when switched on", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const setLiveMedia = (body: object) =>
      request(app).post("/admin/config/live-media").set("Authorization", `Bearer ${admin.accessToken}`).send(body);
    const host = await registerAndLogin(app, "host");
    env.AGORA_CUSTOMER_ID = "test-customer";
    env.AGORA_CUSTOMER_SECRET = "test-secret";
    const agoraRequests = stubFetch(() => ({ status: "success" }));

    try {
      await setLiveMedia({ provider: "agora", agoraKickOnEnd: true });
      const kicked = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
      await request(app).post(`/host/live/broadcasts/${kicked.body.broadcastId}/end`).set("Authorization", `Bearer ${host.accessToken}`);

      await vi.waitFor(() => expect(agoraRequests).toHaveLength(1));
      expect(agoraRequests[0].body).toMatchObject({ cname: `live-${kicked.body.broadcastId}`, privileges: ["join_channel"] });
    } finally {
      await setLiveMedia(AGORA_DEFAULT_LIVE);
    }
  });

  it("only lets finance admins read or change the live switch", async () => {
    const app = createApp();
    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const res = await request(app).post("/admin/config/live-media").set("Authorization", `Bearer ${moderator.accessToken}`).send({ provider: "cloudflare" });
    expect(res.status).toBe(403);
  });
});

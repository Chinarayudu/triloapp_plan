import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin, stubFetch } from "../../test/helpers";
import { chooseCallMedia } from "./callMedia.service";

// The test DB is shared by every test file — tests here that flip the global
// switch put it back to the plain-Agora default in `finally`. They all live in
// this one file so they run one after another, never racing each other.
const AGORA_DEFAULT_CALLS = { provider: "agora", autoP2pPercent: 100, agoraKickOnEnd: false };

describe("Calls: switchable media provider (agora / p2p)", () => {
  let userSocket: Socket | undefined;
  let hostSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    userSocket?.close();
    hostSocket?.close();
    httpServer?.close();
  });

  it("snapshots the admin-selected provider per call and relays p2p signals between the two participants only", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const admin = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const setProvider = (provider: "agora" | "p2p") =>
      request(app).post("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`).send({ provider });

    const host = await registerAndLogin(app, "host");
    await request(app).patch("/host/me/presence").set("Authorization", `Bearer ${host.accessToken}`).send({ isOnline: true });
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);
    const outsider = await registerAndLogin(app, "user");

    const connect = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = ioClient(`http://localhost:${port}`, { auth: { token } });
        socket.on("connect", () => resolve(socket));
        socket.on("connect_error", reject);
      });
    userSocket = await connect(user.accessToken);
    hostSocket = await connect(host.accessToken);

    // The test DB is shared by every test file — always put the global switch back.
    try {
      expect((await setProvider("p2p")).status).toBe(201);
      const config = await request(app).get("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(config.body.current).toBe("p2p");

      const initiate = await request(app)
        .post("/user/calls")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ hostId: host.user.id });
      expect(initiate.status).toBe(201);
      expect(initiate.body.mediaProvider).toBe("p2p");
      expect(initiate.body.agoraToken).toBeNull();
      expect(initiate.body.iceServers.length).toBeGreaterThan(0);
      const callId = initiate.body.callId as string;

      // Flipping the switch mid-call must not change this call's provider.
      await request(app).post("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`).send(AGORA_DEFAULT_CALLS);

      const accept = await request(app).post(`/host/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(accept.body.mediaProvider).toBe("p2p");
      expect(accept.body.agoraToken).toBeNull();

      // Host -> user, and user -> host.
      const userGotSignal = new Promise<{ callId: string; fromUserId: string; data: unknown }>((resolve) =>
        userSocket!.once("call:signal", resolve),
      );
      const offer = { type: "offer", sdp: "v=0 fake-sdp" };
      expect(
        (await request(app).post(`/host/calls/${callId}/signal`).set("Authorization", `Bearer ${host.accessToken}`).send({ data: offer }))
          .status,
      ).toBe(204);
      expect(await userGotSignal).toEqual({ callId, fromUserId: host.user.id, data: offer });

      const hostGotSignal = new Promise<{ data: unknown }>((resolve) => hostSocket!.once("call:signal", resolve));
      const candidate = { type: "candidate", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } };
      await request(app).post(`/user/calls/${callId}/signal`).set("Authorization", `Bearer ${user.accessToken}`).send({ data: candidate });
      expect((await hostGotSignal).data).toEqual(candidate);

      // Someone outside the call can't inject signals; malformed payloads are refused.
      const intruder = await request(app)
        .post(`/user/calls/${callId}/signal`)
        .set("Authorization", `Bearer ${outsider.accessToken}`)
        .send({ data: { type: "hello" } });
      expect(intruder.status).toBe(403);
      const malformed = await request(app)
        .post(`/user/calls/${callId}/signal`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ data: { type: "offer" } });
      expect(malformed.status).toBe(400);

      await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
      const afterEnd = await request(app)
        .post(`/user/calls/${callId}/signal`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ data: { type: "hello" } });
      expect(afterEnd.status).toBe(409);

      // The switch (already back on agora) applies to the next call.
      const next = await request(app)
        .post("/user/calls")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ hostId: host.user.id });
      expect(next.body.mediaProvider).toBe("agora");
      expect(typeof next.body.agoraToken).toBe("string");
      expect(next.body.iceServers).toBeNull();
      const agoraSignal = await request(app)
        .post(`/user/calls/${next.body.callId}/signal`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ data: { type: "hello" } });
      expect(agoraSignal.status).toBe(409);
      await request(app).post(`/user/calls/${next.body.callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
    } finally {
      await request(app).post("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`).send(AGORA_DEFAULT_CALLS);
    }
  });

  it("only lets finance admins read or change the switch", async () => {
    const app = createApp();
    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const res = await request(app)
      .post("/admin/config/call-media")
      .set("Authorization", `Bearer ${moderator.accessToken}`)
      .send({ provider: "p2p" });
    expect(res.status).toBe(403);
  });
});

describe("chooseCallMedia", () => {
  it("maps the admin mode and rollout roll to the provider a new call starts on", () => {
    const config = { autoP2pPercent: 30, agoraKickOnEnd: false };
    expect(chooseCallMedia({ ...config, mode: "agora" }, 0)).toEqual({ mediaProvider: "agora", agoraFallbackAllowed: false });
    expect(chooseCallMedia({ ...config, mode: "p2p" }, 99)).toEqual({ mediaProvider: "p2p", agoraFallbackAllowed: false });
    expect(chooseCallMedia({ ...config, mode: "auto" }, 29.9)).toEqual({ mediaProvider: "p2p", agoraFallbackAllowed: true });
    expect(chooseCallMedia({ ...config, mode: "auto" }, 30)).toEqual({ mediaProvider: "agora", agoraFallbackAllowed: false });
    expect(chooseCallMedia({ ...config, mode: "auto", autoP2pPercent: 0 }, 0).mediaProvider).toBe("agora");
  });
});

describe("Calls: auto mode (p2p with Agora fallback), quality reports, channel close on end", () => {
  let userSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  const savedEnv = { id: env.AGORA_CUSTOMER_ID, secret: env.AGORA_CUSTOMER_SECRET };

  afterEach(() => {
    userSocket?.close();
    httpServer?.close();
    vi.unstubAllGlobals();
    env.AGORA_CUSTOMER_ID = savedEnv.id;
    env.AGORA_CUSTOMER_SECRET = savedEnv.secret;
  });

  it("starts an auto call on p2p, switches it to Agora once on request, and bans the channel when it ends", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const admin = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const setCallMedia = (body: object) =>
      request(app).post("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`).send(body);

    const host = await registerAndLogin(app, "host");
    await request(app).patch("/host/me/presence").set("Authorization", `Bearer ${host.accessToken}`).send({ isOnline: true });
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    userSocket = await new Promise<Socket>((resolve, reject) => {
      const socket = ioClient(`http://localhost:${port}`, { auth: { token: user.accessToken } });
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", reject);
    });
    const fallbackEvents: { callId: string; mediaProvider: string; agoraToken: string; channelName: string }[] = [];
    userSocket.on("call:media-fallback", (payload) => fallbackEvents.push(payload));

    env.AGORA_CUSTOMER_ID = "test-customer";
    env.AGORA_CUSTOMER_SECRET = "test-secret";
    const agoraRequests = stubFetch(() => ({ status: "success" }));

    try {
      expect((await setCallMedia({ provider: "auto", autoP2pPercent: 100, agoraKickOnEnd: true })).status).toBe(201);
      const config = await request(app).get("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(config.body).toMatchObject({ current: "auto", autoP2pPercent: 100, agoraKickOnEnd: true });

      const initiate = await request(app).post("/user/calls").set("Authorization", `Bearer ${user.accessToken}`).send({ hostId: host.user.id });
      expect(initiate.body).toMatchObject({ mediaProvider: "p2p", agoraToken: null, agoraFallbackAllowed: true });
      const callId = initiate.body.callId as string;

      // Not before the call is connected.
      const early = await request(app).post(`/user/calls/${callId}/media-fallback`).set("Authorization", `Bearer ${user.accessToken}`);
      expect(early.status).toBe(409);

      await request(app).post(`/host/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);

      const hostFallback = await request(app).post(`/host/calls/${callId}/media-fallback`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(hostFallback.status).toBe(200);
      expect(hostFallback.body).toMatchObject({ callId, channelName: `call-${callId}`, mediaProvider: "agora", iceServers: null });
      expect(typeof hostFallback.body.agoraToken).toBe("string");

      // The other side is told, with its own token.
      await vi.waitFor(() => expect(fallbackEvents).toHaveLength(1));
      expect(fallbackEvents[0]).toMatchObject({ callId, mediaProvider: "agora", channelName: `call-${callId}` });
      expect(fallbackEvents[0].agoraToken).not.toBe(hostFallback.body.agoraToken);

      // The user giving up at the same moment just gets its token — no second switch or event.
      const userFallback = await request(app).post(`/user/calls/${callId}/media-fallback`).set("Authorization", `Bearer ${user.accessToken}`);
      expect(userFallback.body.mediaProvider).toBe("agora");
      const [row] = await db.select().from(calls).where(eq(calls.id, callId));
      expect(row.mediaProvider).toBe("agora");
      expect(row.mediaFallbackAt).not.toBeNull();
      expect(fallbackEvents).toHaveLength(1);

      // p2p signaling is closed for a call now on Agora.
      const signal = await request(app).post(`/user/calls/${callId}/signal`).set("Authorization", `Bearer ${user.accessToken}`).send({ data: { type: "hello" } });
      expect(signal.status).toBe(409);

      await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
      await vi.waitFor(() => expect(agoraRequests).toHaveLength(1));
      expect(agoraRequests[0].url).toBe("https://api.agora.io/dev/v1/kicking-rule");
      expect(agoraRequests[0].headers.Authorization).toBe(`Basic ${Buffer.from("test-customer:test-secret").toString("base64")}`);
      expect(agoraRequests[0].body).toMatchObject({ cname: `call-${callId}`, time: 240, privileges: ["join_channel"] });

      // End-of-call quality report — once per participant; a retry is ignored.
      const report = { connected: true, connectMs: 1800, relayed: false, avgRttMs: 120, packetLossPercent: 0.5, avgVideoKbps: 900 };
      expect((await request(app).post(`/user/calls/${callId}/media-report`).set("Authorization", `Bearer ${user.accessToken}`).send(report)).status).toBe(204);
      expect((await request(app).post(`/user/calls/${callId}/media-report`).set("Authorization", `Bearer ${user.accessToken}`).send(report)).status).toBe(204);
      const bad = await request(app).post(`/user/calls/${callId}/media-report`).set("Authorization", `Bearer ${user.accessToken}`).send({ connected: "yes" });
      expect(bad.status).toBe(400);

      const quality = await request(app).get("/admin/calls/media-quality?days=1").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(quality.status).toBe(200);
      const agoraStats = quality.body.byProvider.find((p: { mediaProvider: string }) => p.mediaProvider === "agora");
      expect(agoraStats.reports).toBeGreaterThanOrEqual(1);
      expect(quality.body.fellBackToAgora).toBeGreaterThanOrEqual(1);

      // An older admin app sending only { provider } leaves the other settings as they were.
      await setCallMedia({ provider: "p2p" });
      const after = await request(app).get("/admin/config/call-media").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(after.body).toMatchObject({ current: "p2p", autoP2pPercent: 100, agoraKickOnEnd: true });

      // A plain p2p call can't fall back.
      const p2pCall = await request(app).post("/user/calls").set("Authorization", `Bearer ${user.accessToken}`).send({ hostId: host.user.id });
      expect(p2pCall.body.agoraFallbackAllowed).toBe(false);
      await request(app).post(`/host/calls/${p2pCall.body.callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);
      const refused = await request(app).post(`/host/calls/${p2pCall.body.callId}/media-fallback`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(refused.status).toBe(409);
      await request(app).post(`/user/calls/${p2pCall.body.callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
      // Nothing to ban for a call that never touched Agora.
      expect(agoraRequests).toHaveLength(1);
    } finally {
      await setCallMedia(AGORA_DEFAULT_CALLS);
    }
  });
});


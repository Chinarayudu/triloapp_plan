import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

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
      await setProvider("agora");

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
      await setProvider("agora");
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

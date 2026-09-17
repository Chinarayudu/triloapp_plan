import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { checkAbandonedBroadcast, createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

describe("Live broadcasting: room fan-out over socket", () => {
  let viewer1Socket: Socket | undefined;
  let viewer2Socket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    viewer1Socket?.close();
    viewer2Socket?.close();
    httpServer?.close();
  });

  function connect(port: number, token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(`http://localhost:${port}`, { auth: { token } });
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", reject);
    });
  }

  it("delivers live:chat to every current viewer, not to a socket that hasn't joined", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    const viewer1 = await registerAndLogin(app, "user");
    const viewer2 = await registerAndLogin(app, "user"); // never joins

    const start = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    // Socket must connect BEFORE calling /join — room membership is
    // granted to currently-connected sockets, not retroactively.
    viewer1Socket = await connect(port, viewer1.accessToken);
    viewer2Socket = await connect(port, viewer2.accessToken);
    await request(app)
      .post(`/user/live/broadcasts/${broadcastId}/join`)
      .set("Authorization", `Bearer ${viewer1.accessToken}`);
    // viewer2 deliberately does not join.

    const received: unknown[] = [];
    viewer1Socket.on("live:chat", (msg) => received.push(msg));
    viewer2Socket.on("live:chat", (msg) => received.push(msg));

    await request(app)
      .post(`/host/live/broadcasts/${broadcastId}/chat`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ content: "hello viewers" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(1);
    expect((received[0] as { content: string }).content).toBe("hello viewers");
  });

  it("broadcasts a live gift to every viewer in the room, not just the host", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    const sender = await registerAndLogin(app, "user");
    const viewer = await registerAndLogin(app, "user");
    await fundUserWallet(app, sender.accessToken, 5000);

    const start = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    viewer1Socket = await connect(port, viewer.accessToken);
    await request(app).post(`/user/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);

    const giftsRes = await request(app).get("/user/gifts").set("Authorization", `Bearer ${sender.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose");

    const received = new Promise<{ gift: { name: string } }>((resolve) => viewer1Socket!.on("gift:received", resolve));

    await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id, context: "live", contextId: broadcastId });

    expect((await received).gift.name).toBe("Rose");
  });
});

describe("Live broadcasting: auto-ends an abandoned broadcast (BUG_HISTORY.md 2026-09-17)", () => {
  let hostSocket: Socket | undefined;
  let viewerSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    hostSocket?.close();
    viewerSocket?.close();
    httpServer?.close();
  });

  it("ends the broadcast and notifies the room once the host's connection genuinely drops", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    const viewer = await registerAndLogin(app, "user");

    const start = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    hostSocket = await new Promise<Socket>((resolve, reject) => {
      const s = ioClient(`http://localhost:${port}`, { auth: { token: host.accessToken } });
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
    viewerSocket = await new Promise<Socket>((resolve, reject) => {
      const s = ioClient(`http://localhost:${port}`, { auth: { token: viewer.accessToken } });
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
    await request(app).post(`/user/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);

    const ended = new Promise<{ broadcastId: string }>((resolve) => viewerSocket!.on("live:ended", resolve));

    // Simulates a crash/closed-tab/network-loss — never calls the real end
    // endpoint. Calling checkAbandonedBroadcast directly instead of waiting
    // on the real disconnect + grace-period timer, same "drive it
    // deterministically" convention as the call reaper's tests.
    await new Promise<void>((resolve) => {
      hostSocket!.on("disconnect", () => resolve());
      hostSocket!.close();
    });
    // The client's own "disconnect" fires the instant it closes locally,
    // but the server needs a moment longer to notice the closed connection
    // and drop it from the room isUserConnected checks — otherwise
    // checkAbandonedBroadcast still sees the host as connected.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await checkAbandonedBroadcast(host.user.id);

    expect((await ended).broadcastId).toBe(broadcastId);

    // The original bug: this would 409 "You already have a live broadcast
    // running" forever, since nothing ever cleared the stale "live" row.
    const restart = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(restart.status).toBe(201);
  });

  it("leaves the broadcast alone if the host is still connected", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);

    hostSocket = await new Promise<Socket>((resolve, reject) => {
      const s = ioClient(`http://localhost:${port}`, { auth: { token: host.accessToken } });
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });

    await checkAbandonedBroadcast(host.user.id);

    // Still genuinely live — a second start attempt still correctly 409s.
    const second = await request(app).post("/host/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(second.status).toBe(409);
  });
});

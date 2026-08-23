import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSocketServer } from "../../realtime/socket";
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

    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    // Socket must connect BEFORE calling /join — room membership is
    // granted to currently-connected sockets, not retroactively.
    viewer1Socket = await connect(port, viewer1.accessToken);
    viewer2Socket = await connect(port, viewer2.accessToken);
    await request(app)
      .post(`/live/broadcasts/${broadcastId}/join`)
      .set("Authorization", `Bearer ${viewer1.accessToken}`);
    // viewer2 deliberately does not join.

    const received: unknown[] = [];
    viewer1Socket.on("live:chat", (msg) => received.push(msg));
    viewer2Socket.on("live:chat", (msg) => received.push(msg));

    await request(app)
      .post(`/live/broadcasts/${broadcastId}/chat`)
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

    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    viewer1Socket = await connect(port, viewer.accessToken);
    await request(app).post(`/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);

    const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${sender.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose");

    const received = new Promise<{ gift: { name: string } }>((resolve) => viewer1Socket!.on("gift:received", resolve));

    await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id, context: "live", contextId: broadcastId });

    expect((await received).gift.name).toBe("Rose");
  });
});

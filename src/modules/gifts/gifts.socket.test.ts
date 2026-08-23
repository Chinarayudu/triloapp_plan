import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import * as pushLib from "../../lib/push";
import { createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

describe("Gifts: live notifications", () => {
  let clientSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    clientSocket?.close();
    httpServer?.close();
    vi.restoreAllMocks();
  });

  it("delivers gift:received to a connected host when a user sends a gift", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 5000);

    const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose");

    clientSocket = ioClient(`http://localhost:${port}`, { auth: { token: host.accessToken } });
    await new Promise<void>((resolve, reject) => {
      clientSocket!.on("connect", resolve);
      clientSocket!.on("connect_error", reject);
    });

    const received = new Promise<{ gift: { name: string } }>((resolve) => clientSocket!.on("gift:received", resolve));

    await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });

    expect((await received).gift.name).toBe("Rose");
  });

  it("falls back to a push notification when the requested user has no live connection", async () => {
    const app = createApp();
    const pushSpy = vi.spyOn(pushLib, "sendPushNotification").mockResolvedValue();

    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    // No socket server attached to this app instance at all — isUserConnected() reports false.

    await request(app)
      .post("/gifts/request")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ userId: user.user.id });

    expect(pushSpy).toHaveBeenCalledWith(user.user.id, expect.any(String), expect.any(String));
  });
});

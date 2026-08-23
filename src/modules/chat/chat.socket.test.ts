import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import * as pushLib from "../../lib/push";
import { createSocketServer } from "../../realtime/socket";
import { registerAndLogin } from "../../test/helpers";

describe("Chat: live delivery and offline push", () => {
  let recipientSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    recipientSocket?.close();
    httpServer?.close();
    vi.restoreAllMocks();
  });

  it("delivers a message over socket to a connected recipient", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    recipientSocket = ioClient(`http://localhost:${port}`, { auth: { token: host.accessToken } });
    await new Promise<void>((resolve, reject) => {
      recipientSocket!.on("connect", resolve);
      recipientSocket!.on("connect_error", reject);
    });

    const received = new Promise<{ content: string }>((resolve) => recipientSocket!.on("chat:message", resolve));

    await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "live delivery test" });

    expect((await received).content).toBe("live delivery test");
  });

  it("falls back to a push notification when the recipient has no live connection", async () => {
    const app = createApp();
    const pushSpy = vi.spyOn(pushLib, "sendPushNotification").mockResolvedValue();

    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    // No socket connection for the host — createApp() here isn't even
    // attached to a socket server, so isUserConnected() will report false.

    await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "are you there?" });

    expect(pushSpy).toHaveBeenCalledWith(host.user.id, expect.any(String), expect.stringContaining("are you there?"));
  });
});

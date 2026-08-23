import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSocketServer } from "../../realtime/socket";
import { registerAndLogin } from "../../test/helpers";

describe("Presence live updates over socket", () => {
  let clientSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    clientSocket?.close();
    httpServer?.close();
  });

  it("broadcasts presence:update to connected clients when a host toggles online", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const { accessToken, user } = await registerAndLogin(app, "host");

    clientSocket = ioClient(`http://localhost:${port}`, { auth: { token: accessToken } });
    await new Promise<void>((resolve, reject) => {
      clientSocket!.on("connect", resolve);
      clientSocket!.on("connect_error", reject);
    });

    const eventPromise = new Promise<{ hostId: string; isOnline: boolean }>((resolve) => {
      clientSocket!.on("presence:update", resolve);
    });

    await request(app)
      .patch("/me/presence")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ isOnline: true });

    const event = await eventPromise;
    expect(event).toEqual({ hostId: user.id, isOnline: true });
  });

  it("rejects a socket connection with no access token", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    clientSocket = ioClient(`http://localhost:${port}`, { auth: {} });
    const error = await new Promise<Error>((resolve) => {
      clientSocket!.on("connect_error", resolve);
    });
    expect(error.message).toMatch(/auth token/i);
  });
});

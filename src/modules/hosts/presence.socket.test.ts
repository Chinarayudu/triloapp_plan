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
      .patch("/host/me/presence")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ isOnline: true });

    const event = await eventPromise;
    expect(event).toEqual({ hostId: user.id, isOnline: true });
  });

  it("auto-marks a host offline when their last socket disconnects without an explicit toggle", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const { accessToken, user } = await registerAndLogin(app, "host");
    const observer = await registerAndLogin(app, "user");

    await request(app).patch("/host/me/presence").set("Authorization", `Bearer ${accessToken}`).send({ isOnline: true });

    const hostSocket = ioClient(`http://localhost:${port}`, { auth: { token: accessToken } });
    await new Promise<void>((resolve, reject) => {
      hostSocket.on("connect", resolve);
      hostSocket.on("connect_error", reject);
    });

    // A separate connected client (not the host itself) — this is who'd
    // otherwise never learn the host went unreachable.
    clientSocket = ioClient(`http://localhost:${port}`, { auth: { token: observer.accessToken } });
    await new Promise<void>((resolve, reject) => {
      clientSocket!.on("connect", resolve);
      clientSocket!.on("connect_error", reject);
    });

    const offlineEvent = new Promise<{ hostId: string; isOnline: boolean }>((resolve) => {
      clientSocket!.on("presence:update", resolve);
    });

    // Simulates a closed tab / dropped connection — never calls
    // PATCH /me/presence with isOnline:false, same as a real crash/backgrounding.
    hostSocket.close();

    const event = await offlineEvent;
    expect(event).toEqual({ hostId: user.id, isOnline: false });

    const listAfter = await request(app).get("/user/hosts?onlineOnly=true").set("Authorization", `Bearer ${observer.accessToken}`);
    expect(listAfter.body.hosts.find((h: { id: string }) => h.id === user.id)).toBeUndefined();
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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

describe("Calls: live notifications over socket", () => {
  let userSocket: Socket | undefined;
  let hostSocket: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    userSocket?.close();
    hostSocket?.close();
    httpServer?.close();
  });

  it("notifies the host on incoming, the user on accept, and both on end", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ ratePerMinutePaise: 3000 });
    await request(app)
      .patch("/host/me/presence")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isOnline: true });

    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const connect = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = ioClient(`http://localhost:${port}`, { auth: { token } });
        socket.on("connect", () => resolve(socket));
        socket.on("connect_error", reject);
      });

    userSocket = await connect(user.accessToken);
    hostSocket = await connect(host.accessToken);

    const incoming = new Promise<{ callId: string }>((resolve) => hostSocket!.on("call:incoming", resolve));

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;

    const incomingEvent = await incoming;
    expect(incomingEvent.callId).toBe(callId);

    const accepted = new Promise<{ callId: string }>((resolve) => userSocket!.on("call:accepted", resolve));
    await request(app).post(`/host/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);
    const acceptedEvent = await accepted;
    expect(acceptedEvent.callId).toBe(callId);

    const userEnded = new Promise<{ status: string }>((resolve) => userSocket!.on("call:ended", resolve));
    const hostEnded = new Promise<{ status: string }>((resolve) => hostSocket!.on("call:ended", resolve));
    await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);

    expect((await userEnded).status).toBe("completed");
    expect((await hostEnded).status).toBe("completed");
  });

  it("shows the host as busy to other users for exactly the length of an accepted call", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const host = await registerAndLogin(app, "host");
    await request(app)
      .patch("/host/me/presence")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isOnline: true });
    const caller = await registerAndLogin(app, "user");
    await fundUserWallet(app, caller.accessToken, 10000);
    const observer = await registerAndLogin(app, "user");

    // The observer is a third user browsing the host list — not in the call.
    userSocket = await new Promise<Socket>((resolve, reject) => {
      const socket = ioClient(`http://localhost:${port}`, { auth: { token: observer.accessToken } });
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", reject);
    });
    const busyEvents: { hostId: string; isBusy: boolean }[] = [];
    userSocket.on("host:busy", (e) => busyEvents.push(e));
    const isBusyInApi = async () => {
      const detail = await request(app).get(`/user/hosts/${host.user.id}`).set("Authorization", `Bearer ${observer.accessToken}`);
      return detail.body.isBusy;
    };

    const initiate = await request(app)
      .post("/user/calls")
      .set("Authorization", `Bearer ${caller.accessToken}`)
      .send({ hostId: host.user.id });
    const callId = initiate.body.callId as string;
    expect(await isBusyInApi()).toBe(false); // ringing doesn't count as busy

    const becameBusy = new Promise<void>((resolve) => userSocket!.once("host:busy", () => resolve()));
    await request(app).post(`/host/calls/${callId}/accept`).set("Authorization", `Bearer ${host.accessToken}`);
    await becameBusy;
    expect(busyEvents).toEqual([{ hostId: host.user.id, isBusy: true }]);
    expect(await isBusyInApi()).toBe(true);

    const becameFree = new Promise<void>((resolve) => userSocket!.once("host:busy", () => resolve()));
    await request(app).post(`/user/calls/${callId}/end`).set("Authorization", `Bearer ${caller.accessToken}`);
    await becameFree;
    expect(busyEvents).toEqual([
      { hostId: host.user.id, isBusy: true },
      { hostId: host.user.id, isBusy: false },
    ]);
    expect(await isBusyInApi()).toBe(false);
  });
});

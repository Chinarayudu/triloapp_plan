import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSocketServer } from "../../realtime/socket";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

async function cheapestGift(app: ReturnType<typeof createApp>, token: string) {
  const res = await request(app).get("/user/gifts").set("Authorization", `Bearer ${token}`);
  return res.body.gifts[0] as { id: string; name: string; iconUrl: string | null; pricePaise: number };
}

describe("Gifts sent from a chat become chat messages", () => {
  const sockets: Socket[] = [];
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    sockets.forEach((s) => s.close());
    sockets.length = 0;
    httpServer?.close();
  });

  it("creates the conversation if needed, stores a gift message, and charges only the gift price", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const gift = await cheapestGift(app, user.accessToken);
    await fundUserWallet(app, user.accessToken, gift.pricePaise);

    const sent = await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: gift.id, context: "chat" });
    expect(sent.status).toBe(201);
    expect(sent.body.chatMessage).toMatchObject({
      senderId: user.user.id,
      type: "gift",
      gift: { id: gift.id, name: gift.name, iconUrl: gift.iconUrl },
      content: "",
    });

    // Exactly the gift price — no per-message charge on top.
    const wallet = await request(app).get("/user/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(wallet.body.balancePaise).toBe(0);

    const convos = await request(app).get("/host/chat/conversations").set("Authorization", `Bearer ${host.accessToken}`);
    const convo = convos.body.conversations.find((c: { id: string }) => c.id === sent.body.chatMessage.conversationId);
    expect(convo).toBeTruthy();

    const history = await request(app)
      .get(`/host/chat/conversations/${convo.id}/messages`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(history.body.messages).toHaveLength(1);
    expect(history.body.messages[0]).toMatchObject({
      id: sent.body.chatMessage.messageId,
      type: "gift",
      gift: { id: gift.id, name: gift.name, iconUrl: gift.iconUrl },
      chargedPaise: 0,
    });
  });

  it("puts the gift in the existing conversation alongside text messages, which have type: text", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const gift = await cheapestGift(app, user.accessToken);
    await fundUserWallet(app, user.accessToken, 10_000);

    const text = await request(app)
      .post("/user/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "hi" });
    expect(text.body.type).toBe("text");

    // A wrong/foreign contextId from the client doesn't matter — the real conversation is used.
    const sent = await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: gift.id, context: "chat", contextId: "00000000-0000-4000-8000-000000000000" });
    expect(sent.body.chatMessage.conversationId).toBe(text.body.conversationId);

    const history = await request(app)
      .get(`/user/chat/conversations/${text.body.conversationId}/messages`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(history.body.messages.map((m: { type: string }) => m.type)).toEqual(["gift", "text"]); // newest first
    expect(history.body.messages[1].gift).toBeNull();
  });

  it("gifts outside a chat don't create a chat message", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const gift = await cheapestGift(app, user.accessToken);
    await fundUserWallet(app, user.accessToken, gift.pricePaise);

    const sent = await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: gift.id });
    expect(sent.status).toBe(201);
    expect(sent.body.chatMessage).toBeNull();
    const convos = await request(app).get("/host/chat/conversations").set("Authorization", `Bearer ${host.accessToken}`);
    expect(convos.body.conversations).toHaveLength(0);
  });

  it("refuses a chat gift between blocked users without charging", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const gift = await cheapestGift(app, user.accessToken);
    await fundUserWallet(app, user.accessToken, gift.pricePaise);
    await request(app).post("/host/moderation/blocks").set("Authorization", `Bearer ${host.accessToken}`).send({ userId: user.user.id });

    const sent = await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: gift.id, context: "chat" });
    expect(sent.status).toBe(403);
    const wallet = await request(app).get("/user/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(wallet.body.balancePaise).toBe(gift.pricePaise);
  });

  it("sends chat:message with the gift to both people live", async () => {
    const app = createApp();
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const gift = await cheapestGift(app, user.accessToken);
    await fundUserWallet(app, user.accessToken, gift.pricePaise);

    const connect = async (token: string) => {
      const socket = ioClient(`http://localhost:${port}`, { auth: { token } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", resolve);
        socket.on("connect_error", reject);
      });
      return socket;
    };
    const hostSocket = await connect(host.accessToken);
    const userSocket = await connect(user.accessToken);
    const hostGot = new Promise<Record<string, unknown>>((resolve) => hostSocket.on("chat:message", resolve));
    const userGot = new Promise<Record<string, unknown>>((resolve) => userSocket.on("chat:message", resolve));

    const sent = await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: gift.id, context: "chat" });

    for (const payload of [await hostGot, await userGot]) {
      expect(payload).toMatchObject({
        messageId: sent.body.chatMessage.messageId,
        conversationId: sent.body.chatMessage.conversationId,
        senderId: user.user.id,
        type: "gift",
        gift: { id: gift.id, name: gift.name },
      });
    }
  });
});

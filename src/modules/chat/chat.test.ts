import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Chat: sending and reading messages", () => {
  it("sends a message, creates a conversation, and a reply reuses the same conversation", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const first = await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "Hi there!" });
    expect(first.status).toBe(201);
    expect(first.body.content).toBe("Hi there!");
    const conversationId = first.body.conversationId;

    const reply = await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ recipientId: user.user.id, content: "Hello!" });
    expect(reply.status).toBe(201);
    expect(reply.body.conversationId).toBe(conversationId); // same conversation, not a new one

    const history = await request(app)
      .get(`/chat/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(2);
    // newest first
    expect(history.body.messages[0].content).toBe("Hello!");
    expect(history.body.messages[1].content).toBe("Hi there!");
  });

  it("lists conversations for both participants with the other party's info", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "Are you free?" });

    const userView = await request(app).get("/chat/conversations").set("Authorization", `Bearer ${user.accessToken}`);
    expect(userView.status).toBe(200);
    const userConvo = userView.body.conversations.find((c: { otherParticipant: { id: string } }) => c.otherParticipant.id === host.user.id);
    expect(userConvo).toBeTruthy();
    expect(userConvo.otherParticipant.role).toBe("host");

    const hostView = await request(app).get("/chat/conversations").set("Authorization", `Bearer ${host.accessToken}`);
    const hostConvo = hostView.body.conversations.find((c: { otherParticipant: { id: string } }) => c.otherParticipant.id === user.user.id);
    expect(hostConvo).toBeTruthy();
    expect(hostConvo.otherParticipant.role).toBe("user");
  });

  it("rejects a user messaging another user", async () => {
    const app = createApp();
    const user1 = await registerAndLogin(app, "user");
    const user2 = await registerAndLogin(app, "user");

    const res = await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ recipientId: user2.user.id, content: "hi" });
    expect(res.status).toBe(400);
  });

  it("rejects reading a conversation you're not part of", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const outsider = await registerAndLogin(app, "user");

    const sendRes = await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "private" });

    const res = await request(app)
      .get(`/chat/conversations/${sendRes.body.conversationId}/messages`)
      .set("Authorization", `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects empty message content", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const res = await request(app)
      .post("/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "" });
    expect(res.status).toBe(400);
  });
});

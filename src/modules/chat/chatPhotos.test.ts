import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { deleteObject } from "../../lib/s3";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// A real upload to the local S3 (MinIO), same as the KYC upload tests. Image
// moderation doesn't run against MinIO.
describe("Chat photos", () => {
  const keysToCleanUp: string[] = [];
  afterEach(async () => {
    for (const key of keysToCleanUp.splice(0)) await deleteObject(key).catch(() => {});
  });

  it("uploads a photo and sends it as a paid image message with a signed URL everywhere it's served", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 10_000);

    const notAPhoto = await request(app)
      .post("/user/chat/attachments/upload-url")
      .set(bearer(user.accessToken))
      .send({ recipientId: host.user.id, contentType: "application/pdf" });
    expect(notAPhoto.status).toBe(400);

    const issued = await request(app)
      .post("/user/chat/attachments/upload-url")
      .set(bearer(user.accessToken))
      .send({ recipientId: host.user.id, contentType: "image/jpeg" });
    expect(issued.status).toBe(201);
    expect(issued.body.mediaKey).toMatch(new RegExp(`^chat/[0-9a-f-]+/${user.user.id}/[0-9a-f-]+\\.jpg$`));
    expect(issued.body.expiresIn).toBe(300);
    keysToCleanUp.push(issued.body.mediaKey);

    // Sending before the upload exists is refused.
    const early = await request(app)
      .post("/user/chat/messages")
      .set(bearer(user.accessToken))
      .send({ recipientId: host.user.id, type: "image", mediaKey: issued.body.mediaKey });
    expect(early.status).toBe(400);

    const put = await fetch(issued.body.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: Buffer.from("fake-jpeg-bytes") });
    expect(put.ok).toBe(true);

    const sent = await request(app)
      .post("/user/chat/messages")
      .set(bearer(user.accessToken))
      .send({ recipientId: host.user.id, type: "image", mediaKey: issued.body.mediaKey, content: "" });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ type: "image", content: "" });
    expect(sent.body.mediaUrl).toContain(issued.body.mediaKey);
    // A photo costs the same as a text message.
    expect(sent.body.chargedPaise).toBeGreaterThan(0);

    const history = await request(app).get(`/host/chat/conversations/${sent.body.conversationId}/messages`).set(bearer(host.accessToken));
    expect(history.body.messages[0]).toMatchObject({ type: "image", mediaKey: issued.body.mediaKey });
    expect(history.body.messages[0].mediaUrl).toContain(issued.body.mediaKey);
    const downloaded = await fetch(history.body.messages[0].mediaUrl);
    expect(await downloaded.text()).toBe("fake-jpeg-bytes");

    // A key issued to someone else can't be reused.
    const otherUser = await registerAndLogin(app, "user");
    await fundUserWallet(app, otherUser.accessToken, 10_000);
    const stolen = await request(app)
      .post("/user/chat/messages")
      .set(bearer(otherUser.accessToken))
      .send({ recipientId: host.user.id, type: "image", mediaKey: issued.body.mediaKey });
    expect(stolen.status).toBe(400);

    // Text messages work as before, and now say what they are.
    const text = await request(app).post("/user/chat/messages").set(bearer(user.accessToken)).send({ recipientId: host.user.id, content: "Hi" });
    expect(text.body).toMatchObject({ type: "text", content: "Hi", mediaUrl: null });
    const empty = await request(app).post("/user/chat/messages").set(bearer(user.accessToken)).send({ recipientId: host.user.id, content: "" });
    expect(empty.status).toBe(400);
  });
});

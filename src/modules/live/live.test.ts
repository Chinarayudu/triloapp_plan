import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

describe("Live broadcasting: lifecycle", () => {
  it("starts a broadcast and lists it with a live viewer count", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");

    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(start.status).toBe(201);
    expect(start.body.status).toBe("live");
    expect(start.body.channelName).toBe(`live-${start.body.broadcastId}`);

    const list = await request(app).get("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const found = list.body.broadcasts.find((b: { id: string }) => b.id === start.body.broadcastId);
    expect(found).toBeTruthy();
    expect(found.viewerCount).toBe(0);
  });

  it("rejects starting a second broadcast while one is already live", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);

    const second = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(second.status).toBe(409);
  });

  it("tracks concurrent viewers and peak count as users join and leave", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user1 = await registerAndLogin(app, "user");
    const user2 = await registerAndLogin(app, "user");

    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    const join1 = await request(app)
      .post(`/live/broadcasts/${broadcastId}/join`)
      .set("Authorization", `Bearer ${user1.accessToken}`);
    expect(join1.status).toBe(200);

    // Rejoining without leaving is idempotent, not a second viewer.
    await request(app).post(`/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${user1.accessToken}`);

    await request(app).post(`/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${user2.accessToken}`);

    let single = await request(app).get(`/live/broadcasts/${broadcastId}`).set("Authorization", `Bearer ${host.accessToken}`);
    expect(single.body.peakViewerCount).toBe(2);

    await request(app).post(`/live/broadcasts/${broadcastId}/leave`).set("Authorization", `Bearer ${user2.accessToken}`);

    const list = await request(app).get("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const found = list.body.broadcasts.find((b: { id: string }) => b.id === broadcastId);
    expect(found.viewerCount).toBe(1); // concurrent, not peak — peak stays 2

    single = await request(app).get(`/live/broadcasts/${broadcastId}`).set("Authorization", `Bearer ${host.accessToken}`);
    expect(single.body.peakViewerCount).toBe(2);
  });

  it("rejects joining a broadcast that doesn't exist", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const res = await request(app)
      .post("/live/broadcasts/00000000-0000-0000-0000-000000000000/join")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("ends a broadcast — status becomes ended and it drops off the live list", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;

    const end = await request(app)
      .post(`/live/broadcasts/${broadcastId}/end`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(end.status).toBe(200);
    expect(end.body.status).toBe("ended");

    const list = await request(app).get("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(list.body.broadcasts.find((b: { id: string }) => b.id === broadcastId)).toBeUndefined();

    // The host is free to go live again immediately.
    const restart = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(restart.status).toBe(201);
  });

  it("rejects a non-host ending someone else's broadcast", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");
    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);

    const res = await request(app)
      .post(`/live/broadcasts/${start.body.broadcastId}/end`)
      .set("Authorization", `Bearer ${otherHost.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe("Live broadcasting: chat authorization", () => {
  it("lets the host and an active viewer chat, but not a bystander who never joined", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const viewer = await registerAndLogin(app, "user");
    const bystander = await registerAndLogin(app, "user");

    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    const broadcastId = start.body.broadcastId;
    await request(app).post(`/live/broadcasts/${broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);

    const hostChat = await request(app)
      .post(`/live/broadcasts/${broadcastId}/chat`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ content: "Welcome everyone!" });
    expect(hostChat.status).toBe(201);

    const viewerChat = await request(app)
      .post(`/live/broadcasts/${broadcastId}/chat`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ content: "Hi!" });
    expect(viewerChat.status).toBe(201);

    const bystanderChat = await request(app)
      .post(`/live/broadcasts/${broadcastId}/chat`)
      .set("Authorization", `Bearer ${bystander.accessToken}`)
      .send({ content: "let me in" });
    expect(bystanderChat.status).toBe(403);
  });

  it("rejects chatting in a broadcast that has ended", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    await request(app).post(`/live/broadcasts/${start.body.broadcastId}/end`).set("Authorization", `Bearer ${host.accessToken}`);

    const res = await request(app)
      .post(`/live/broadcasts/${start.body.broadcastId}/chat`)
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ content: "hello?" });
    expect(res.status).toBe(404);
  });
});

describe("Live broadcasting: admin monitoring (admin design follow-up)", () => {
  it("lists currently-live broadcasts with host identity and viewer count, and can force-end one", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const viewer = await registerAndLogin(app, "user");
    const start = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    await request(app).post(`/live/broadcasts/${start.body.broadcastId}/join`).set("Authorization", `Bearer ${viewer.accessToken}`);

    const admin = await registerAndLoginAdmin();
    const list = await request(app).get("/admin/live-broadcasts").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(list.status).toBe(200);
    const listed = list.body.broadcasts.find((b: { id: string }) => b.id === start.body.broadcastId);
    expect(listed).toBeTruthy();
    expect(listed.host.id).toBe(host.user.id);
    expect(listed.viewerCount).toBe(1);

    const forceEnd = await request(app)
      .post(`/admin/live-broadcasts/${start.body.broadcastId}/end`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(forceEnd.status).toBe(200);
    expect(forceEnd.body.status).toBe("ended");

    const listAfter = await request(app).get("/admin/live-broadcasts").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(listAfter.body.broadcasts.find((b: { id: string }) => b.id === start.body.broadcastId)).toBeUndefined();
  });
});

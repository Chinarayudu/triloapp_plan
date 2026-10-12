import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Host discovery + presence (REST)", () => {
  it("lists a newly-created host at their level's price", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app, "host");
    // A language no other host has, searched for with q, finds this host
    // however many host rows earlier test runs left in the test DB.
    const language = `Lang-${randomUUID()}`;
    await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ languages: [language] });

    const res = await request(app)
      .get(`/host/hosts?q=${language}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const found = res.body.hosts.find((h: { id: string }) => h.id === user.id);
    expect(found).toBeTruthy();
    expect(found.ratePerMinutePaise).toBe(3000); // Level 1 video
    expect(found.isOnline).toBe(false);
  });

  it("reflects a presence toggle in the host list and rejects it from non-hosts", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const plainUser = await registerAndLogin(app, "user");

    const forbidden = await request(app)
      .patch("/user/me/presence")
      .set("Authorization", `Bearer ${plainUser.accessToken}`)
      .send({ isOnline: true });
    expect(forbidden.status).toBe(403);

    const toggled = await request(app)
      .patch("/host/me/presence")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isOnline: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.isOnline).toBe(true);

    const onlineOnly = await request(app)
      .get("/host/hosts?onlineOnly=true&pageSize=50")
      .set("Authorization", `Bearer ${host.accessToken}`);
    const found = onlineOnly.body.hosts.find((h: { id: string }) => h.id === host.user.id);
    expect(found).toBeTruthy();
    expect(found.isOnline).toBe(true);
  });

  it("requires authentication to browse the host list", async () => {
    const app = createApp();
    const res = await request(app).get("/user/hosts");
    expect(res.status).toBe(401);
  });
});

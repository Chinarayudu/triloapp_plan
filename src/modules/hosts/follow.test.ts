import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Host follows (BR-NOTIF-01 'a followed host going live')", () => {
  it("follows a host, lists it, then unfollows — idempotently on both ends", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const followed = await request(app)
      .post(`/hosts/${host.user.id}/follow`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(followed.status).toBe(200);

    // Following twice is a no-op, not a duplicate/error.
    const followedAgain = await request(app)
      .post(`/hosts/${host.user.id}/follow`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(followedAgain.status).toBe(200);

    const list = await request(app).get("/me/following").set("Authorization", `Bearer ${user.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.hosts).toHaveLength(1);
    expect(list.body.hosts[0].hostId).toBe(host.user.id);

    const unfollowed = await request(app)
      .post(`/hosts/${host.user.id}/unfollow`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(unfollowed.status).toBe(200);

    // Unfollowing something never followed is also a no-op, not an error.
    const unfollowedAgain = await request(app)
      .post(`/hosts/${host.user.id}/unfollow`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(unfollowedAgain.status).toBe(200);

    const listAfter = await request(app).get("/me/following").set("Authorization", `Bearer ${user.accessToken}`);
    expect(listAfter.body.hosts).toHaveLength(0);
  });

  it("rejects following a non-host account, and a host following anyone at all", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const otherUser = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const followUser = await request(app)
      .post(`/hosts/${otherUser.user.id}/follow`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(followUser.status).toBe(404);

    const hostTriesToFollow = await request(app)
      .post(`/hosts/${otherUser.user.id}/follow`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(hostTriesToFollow.status).toBe(403); // requireRole("user")
  });

  it("a host going live notifies followers over the socket without erroring for a host with none", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const follower = await registerAndLogin(app, "user");
    await request(app).post(`/hosts/${host.user.id}/follow`).set("Authorization", `Bearer ${follower.accessToken}`);

    const started = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${host.accessToken}`);
    expect(started.status).toBe(201); // notifyFollowersHostWentLive ran and didn't blow up the request

    // A second host with zero followers going live is the common case and
    // must not error either (listFollowerIds returning [] short-circuits).
    const lonelyHost = await registerAndLogin(app, "host");
    const lonelyStart = await request(app).post("/live/broadcasts").set("Authorization", `Bearer ${lonelyHost.accessToken}`);
    expect(lonelyStart.status).toBe(201);
  });
});

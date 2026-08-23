import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Host discovery + presence (REST)", () => {
  it("lists a newly-created host once their rate is set", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app, "host");
    // rate=1 + sort=rate_asc guarantees this host sorts to (near) the very
    // front regardless of how many host rows past test runs have left in
    // the shared dev DB — pageSize alone isn't reliable against that
    // accumulation (see BUG_HISTORY.md workflow: not a product bug, a
    // known tradeoff pending a dedicated test DB branch).
    await request(app)
      .patch("/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ ratePerMinutePaise: 1 });

    const res = await request(app)
      .get("/hosts?pageSize=50&sort=rate_asc")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const found = res.body.hosts.find((h: { id: string }) => h.id === user.id);
    expect(found).toBeTruthy();
    expect(found.ratePerMinutePaise).toBe(1);
    expect(found.isOnline).toBe(false);
  });

  it("reflects a presence toggle in the host list and rejects it from non-hosts", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const plainUser = await registerAndLogin(app, "user");

    const forbidden = await request(app)
      .patch("/me/presence")
      .set("Authorization", `Bearer ${plainUser.accessToken}`)
      .send({ isOnline: true });
    expect(forbidden.status).toBe(403);

    const toggled = await request(app)
      .patch("/me/presence")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isOnline: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.isOnline).toBe(true);

    const onlineOnly = await request(app)
      .get("/hosts?onlineOnly=true&pageSize=50")
      .set("Authorization", `Bearer ${host.accessToken}`);
    const found = onlineOnly.body.hosts.find((h: { id: string }) => h.id === host.user.id);
    expect(found).toBeTruthy();
    expect(found.isOnline).toBe(true);
  });

  it("requires authentication to browse the host list", async () => {
    const app = createApp();
    const res = await request(app).get("/hosts");
    expect(res.status).toBe(401);
  });
});

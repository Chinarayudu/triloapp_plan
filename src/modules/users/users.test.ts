import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Profile endpoints", () => {
  it("returns the current user via GET /me", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app);
    const res = await request(app).get("/user/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.hostProfile).toBeUndefined();
  });

  it("updates name/email/dob via PATCH /me", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app)
      .patch("/user/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Test User", email: "test@example.com", dob: "2000-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Test User");
    expect(res.body.dob).toBe("2000-01-01");
  });

  it("rejects host-profile updates from a USER role", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");
    const res = await request(app)
      .patch("/user/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bio: "hi" });
    expect(res.status).toBe(403);
  });

  it("updates bio/rate for a HOST role", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");
    const res = await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bio: "Hi there", ratePerMinutePaise: 2500 }); // under the Level 1 video max of ₹30
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Hi there");
    expect(res.body.ratePerMinutePaise).toBe(2500);
  });

  const beautySettings = {
    enabled: true,
    preset: { id: "fine_smooth", intensity: 40 },
    filterId: "vintage",
    custom: {
      exposure: 0,
      brightness: 10,
      contrast: 5,
      saturation: 0,
      temperature: 3,
      tint: 0,
      highlights: 0,
      shadows: 0,
      sharpness: 0,
      vibrance: 0,
    },
  };

  it("saves and round-trips beauty settings for a HOST role", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");

    const patchRes = await request(app)
      .patch("/host/me/beauty-settings")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(beautySettings);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual(beautySettings);

    const meRes = await request(app).get("/host/me").set("Authorization", `Bearer ${accessToken}`);
    expect(meRes.body.hostProfile.beautySettings).toEqual(beautySettings);
  });

  it("rejects beauty-settings updates from a USER role", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");
    const res = await request(app)
      .patch("/user/me/beauty-settings")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(beautySettings);
    expect(res.status).toBe(403);
  });

  it("rejects beauty-settings updates with an out-of-range custom value", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");
    const res = await request(app)
      .patch("/host/me/beauty-settings")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ ...beautySettings, custom: { ...beautySettings.custom, exposure: 51 } });
    expect(res.status).toBe(400);
  });
});

// KYC document upload/view tests live in kyc.test.ts — they exercise a
// real S3 round trip, which needs its own setup/cleanup.

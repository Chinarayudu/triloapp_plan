import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Profile endpoints", () => {
  it("returns the current user via GET /me", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app);
    const res = await request(app).get("/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.hostProfile).toBeUndefined();
  });

  it("updates name/email/dob via PATCH /me", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app)
      .patch("/me")
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
      .patch("/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bio: "hi" });
    expect(res.status).toBe(403);
  });

  it("updates bio/rate for a HOST role", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");
    const res = await request(app)
      .patch("/me/host-profile")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bio: "Hi there", ratePerMinutePaise: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Hi there");
    expect(res.body.ratePerMinutePaise).toBe(5000);
  });
});

// KYC document upload/view tests live in kyc.test.ts — they exercise a
// real S3 round trip, which needs its own setup/cleanup.

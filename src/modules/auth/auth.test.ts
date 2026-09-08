import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { hashPassword } from "../../lib/password";
import { randomPhone, registerAndLogin } from "../../test/helpers";

describe("Auth: OTP + JWT flow", () => {
  it("registers a new user via OTP and returns a token pair", async () => {
    const app = createApp();
    const phone = randomPhone();

    const requestRes = await request(app).post("/auth/otp/request").send({ phone });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.devCode).toMatch(/^\d{6}$/);

    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ phone, code: requestRes.body.devCode });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.user.role).toBe("user");
    expect(verifyRes.body.accessToken).toBeTruthy();
    expect(verifyRes.body.refreshToken).toBeTruthy();
  });

  it("rejects an incorrect code", async () => {
    const app = createApp();
    const phone = randomPhone();
    await request(app).post("/auth/otp/request").send({ phone });

    const res = await request(app).post("/auth/otp/verify").send({ phone, code: "000000" });
    expect(res.status).toBe(400);
  });

  it("creates a host profile when role=host on first signup", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app, "host");
    expect(user.role).toBe("host");

    const meRes = await request(app).get("/me").set("Authorization", `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.hostProfile).toBeTruthy();
  });

  it("keeps an existing user's role even if verify is called again with a different role", async () => {
    const app = createApp();
    const phone = randomPhone();
    const firstReq = await request(app).post("/auth/otp/request").send({ phone });
    await request(app).post("/auth/otp/verify").send({ phone, code: firstReq.body.devCode, role: "user" });

    const secondReq = await request(app).post("/auth/otp/request").send({ phone });
    const secondVerify = await request(app)
      .post("/auth/otp/verify")
      .send({ phone, code: secondReq.body.devCode, role: "host" });

    expect(secondVerify.body.user.role).toBe("user");
  });

  it("rotates the refresh token and invalidates the old one on reuse", async () => {
    const app = createApp();
    const { refreshToken } = await registerAndLogin(app);

    const refreshRes = await request(app).post("/auth/token/refresh").send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);

    const replayRes = await request(app).post("/auth/token/refresh").send({ refreshToken });
    expect(replayRes.status).toBe(401);
  });

  it("rejects requests without a valid access token", async () => {
    const app = createApp();
    const res = await request(app).get("/me");
    expect(res.status).toBe(401);
  });
});

describe("Auth: admin email+password login (Phase 9 follow-up)", () => {
  it("logs an admin in via email+password, and never reveals whether the email exists on failure", async () => {
    const app = createApp();
    const email = `admin-${randomPhone().slice(1)}@example.com`; // unique per run, same as randomPhone's uniqueness

    const created = await request(app)
      .post("/auth/admin/login")
      .send({ email, password: "wrong-password-first" });
    expect(created.status).toBe(401); // no such account yet — same generic error as a real one with a wrong password

    // Provisioned the same way db:seedAdmin.ts does — direct DB insert with
    // a hashed password, not through any signup endpoint (none exists).
    await db.insert(users).values({
      phone: randomPhone(),
      email,
      role: "admin",
      passwordHash: await hashPassword("correct-horse-battery-staple"),
    });

    const wrongPassword = await request(app).post("/auth/admin/login").send({ email, password: "nope" });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error).toBe(created.body.error); // identical error either way

    const ok = await request(app).post("/auth/admin/login").send({ email, password: "correct-horse-battery-staple" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe("admin");
    expect(ok.body.accessToken).toBeTruthy();
  });

  it("rejects a User/Host account even with a matching email — this endpoint is admin/sub-admin only", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");
    const email = `user-${randomPhone().slice(1)}@example.com`;
    await request(app).patch("/me").set("Authorization", `Bearer ${accessToken}`).send({ email });

    // This account has no passwordHash at all (Users/Hosts never get one),
    // so any password is rejected the same generic way.
    const res = await request(app).post("/auth/admin/login").send({ email, password: "anything" });
    expect(res.status).toBe(401);
  });
});

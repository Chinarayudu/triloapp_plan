import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
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

import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { randomPhone, registerAndLogin } from "../../test/helpers";

// The real check needs a token signed by Google for our Firebase project, so
// it's faked here: "valid:<phone>" is a token for that phone, anything else is
// rejected the way the real module rejects a bad token.
vi.mock("../../lib/firebaseAuth", () => ({
  verifyFirebasePhoneToken: async (idToken: string) => {
    if (idToken.startsWith("valid:")) return idToken.slice("valid:".length);
    throw new AppError(401, "Invalid or expired Firebase token — verify the phone number again");
  },
}));

import { createApp } from "../../app";

describe("Firebase phone login", () => {
  it("signs a new user up with the phone from the token, and logs the same account in next time", async () => {
    const app = createApp();
    const phone = randomPhone();

    const first = await request(app).post("/user/auth/firebase/verify").send({ idToken: `valid:${phone}`, role: "user" });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.refreshToken).toBeTruthy();
    expect(first.body.user).toMatchObject({ role: "user", phone });

    const again = await request(app).post("/user/auth/firebase/verify").send({ idToken: `valid:${phone}` });
    expect(again.status).toBe(200);
    expect(again.body.user.id).toBe(first.body.user.id);

    const me = await request(app).get("/user/me").set("Authorization", `Bearer ${first.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("keeps a phone's user and host accounts separate, and applies a host referral code", async () => {
    const app = createApp();
    const referrer = await registerAndLogin(app, "host");
    const me = await request(app).get("/host/me").set("Authorization", `Bearer ${referrer.accessToken}`);
    const phone = randomPhone();

    const asUser = await request(app).post("/user/auth/firebase/verify").send({ idToken: `valid:${phone}`, role: "user" });
    const asHost = await request(app)
      .post("/host/auth/firebase/verify")
      .send({ idToken: `valid:${phone}`, role: "host", referralCode: me.body.referralCode });
    expect(asHost.status).toBe(200);
    expect(asHost.body.user.role).toBe("host");
    expect(asHost.body.user.id).not.toBe(asUser.body.user.id);
    expect(asHost.body.referralApplied).toBe(true);
  });

  it("logs into the same account an OTP login created", async () => {
    const app = createApp();
    const existing = await registerAndLogin(app, "user");
    const res = await request(app).post("/user/auth/firebase/verify").send({ idToken: `valid:${existing.user.phone}`, role: "user" });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(existing.user.id);
  });

  it("rejects a bad token and a missing one", async () => {
    const app = createApp();
    const bad = await request(app).post("/user/auth/firebase/verify").send({ idToken: "forged" });
    expect(bad.status).toBe(401);
    const missing = await request(app).post("/user/auth/firebase/verify").send({});
    expect(missing.status).toBe(400);
  });
});

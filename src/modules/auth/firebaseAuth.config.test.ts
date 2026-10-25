import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";

// No fake here: tests run without the FIREBASE_* settings (vitest.config.ts),
// exactly like a server that hasn't been given them yet.
describe("Firebase phone login without Firebase configured", () => {
  it("answers 503 with a clear message instead of failing obscurely", async () => {
    const res = await request(createApp()).post("/user/auth/firebase/verify").send({ idToken: "anything" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/isn't configured/);
  });
});

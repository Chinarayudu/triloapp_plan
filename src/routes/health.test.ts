import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("GET /health", () => {
  it("returns 200 and reports the database reachable", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });
});

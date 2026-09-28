import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { calls } from "../../db/schema";
import { registerAndLogin } from "../../test/helpers";
import { getCurrentPaisePerBean } from "../wallet/wallet.service";
import { callDurationQuality } from "./calls.service";

describe("Call lists (paginated)", () => {
  it("pages a host's and a user's calls in the database, newest first, with filters and all-pages totals", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    const ppb = await getCurrentPaisePerBean();

    // 25 calls a minute apart: every 5th is missed, odd ones are voice.
    const base = Date.parse("2026-09-01T10:00:00Z");
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const missed = i % 5 === 0;
      const startedAt = missed ? null : new Date(base + i * 60_000);
      rows.push({
        userId: user.user.id,
        hostId: host.user.id,
        type: i % 2 === 1 ? ("voice" as const) : ("video" as const),
        status: missed ? ("missed" as const) : ("completed" as const),
        ratePerMinutePaiseSnapshot: 1000,
        commissionBasisPointsSnapshot: 3000,
        paisePerBeanSnapshot: 1,
        startedAt,
        endedAt: startedAt ? new Date(startedAt.getTime() + 30_000) : null,
        totalAmountPaise: missed ? 0 : 1000,
        totalBeans: missed ? 0 : 700,
        createdAt: new Date(base + i * 60_000),
      });
    }
    await db.insert(calls).values(rows);
    const hostAuth = { Authorization: `Bearer ${host.accessToken}` };

    const page1 = await request(app).get("/host/me/calls?page=1&pageSize=10").set(hostAuth);
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ total: 25, page: 1, pageSize: 10, hasMore: true });
    expect(page1.body.calls).toHaveLength(10);
    // Newest first.
    expect(page1.body.calls[0].createdAt).toBe(new Date(base + 24 * 60_000).toISOString());
    expect(page1.body.calls[0]).toMatchObject({ userId: user.user.id, callerName: expect.any(String), durationSeconds: 30, earnedPaise: 700 * ppb, durationQuality: "bad" });
    // Totals cover every page, not just this one.
    expect(page1.body.summary).toEqual({ totalCalls: 25, earnedPaise: 20 * 700 * ppb });

    const page3 = await request(app).get("/host/me/calls?page=3&pageSize=10").set(hostAuth);
    expect(page3.body.calls).toHaveLength(5);
    expect(page3.body.hasMore).toBe(false);
    const ids = new Set([...page1.body.calls, ...page3.body.calls].map((c: { id: string }) => c.id));
    expect(ids.size).toBe(15);

    const missed = await request(app).get("/host/me/calls?filter=missed").set(hostAuth);
    expect(missed.body.total).toBe(5);
    expect(missed.body.calls.every((c: { status: string }) => c.status === "missed")).toBe(true);
    expect(missed.body.summary.earnedPaise).toBe(0);
    expect(missed.body.calls.every((c: { durationQuality: string | null }) => c.durationQuality === null)).toBe(true);

    const voice = await request(app).get("/host/me/calls?filter=voice").set(hostAuth);
    expect(voice.body.total).toBe(12);

    const userVideo = await request(app)
      .get("/user/me/calls?filter=video&pageSize=50")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(userVideo.status).toBe(200);
    expect(userVideo.body).toMatchObject({ total: 13, hasMore: false });
    expect(userVideo.body.calls.every((c: { type: string }) => c.type === "video")).toBe(true);
    expect(userVideo.body.calls.find((c: { status: string }) => c.status === "completed").durationQuality).toBe("bad");

    const stranger = await request(app).get("/host/me/calls").set("Authorization", `Bearer ${otherHost.accessToken}`);
    expect(stranger.body.total).toBe(0);

    const badFilter = await request(app).get("/host/me/calls?filter=nope").set(hostAuth);
    expect(badFilter.status).toBe(400);
  });

  it("grades a finished call by length: under 4 min bad, 4–10 min good, over 10 min excellent", () => {
    const start = new Date("2026-09-01T10:00:00Z");
    const endedAfter = (seconds: number) => ({ startedAt: start, endedAt: new Date(start.getTime() + seconds * 1000) });

    expect(callDurationQuality(endedAfter(3 * 60 + 59))).toBe("bad");
    expect(callDurationQuality(endedAfter(4 * 60))).toBe("good");
    expect(callDurationQuality(endedAfter(10 * 60))).toBe("good");
    expect(callDurationQuality(endedAfter(10 * 60 + 1))).toBe("excellent");
    // Never connected, or still in progress.
    expect(callDurationQuality({ startedAt: null, endedAt: start })).toBeNull();
    expect(callDurationQuality({ startedAt: start, endedAt: null })).toBeNull();
  });
});

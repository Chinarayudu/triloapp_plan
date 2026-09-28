import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { calls, hostOnlineSessions, ledgerEntries, liveBroadcasts } from "../../db/schema";
import { addDays, dateInTimeZone } from "../../lib/dayBounds";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";
import { sweepOnlineSessions } from "../hosts/onlineSessionSweep";
import { getCurrentPaisePerBean } from "./wallet.service";

const at = (iso: string) => new Date(iso);

async function hostCredit(hostId: string, beans: number, referenceType: "call_billing" | "chat_message" | "withdrawal", referenceId: string, createdAt: Date) {
  await db.insert(ledgerEntries).values({
    walletType: "host",
    ownerId: hostId,
    direction: "credit",
    amount: beans,
    referenceType,
    referenceId,
    balanceAfter: 0,
    idempotencyKey: `test:${randomUUID()}`,
    createdAt,
  });
}

async function insertCall(values: { userId: string; hostId: string; type: "video" | "voice"; status: "completed" | "missed"; createdAt: Date; startedAt?: Date; endedAt?: Date }) {
  const [row] = await db
    .insert(calls)
    .values({ ...values, ratePerMinutePaiseSnapshot: 1000, commissionBasisPointsSnapshot: 3000, paisePerBeanSnapshot: 1 })
    .returning();
  return row;
}

describe("Host daily report", () => {
  // 2026-09-20 in IST is 2026-09-19T18:30Z .. 2026-09-20T18:30Z.
  it("splits online time at IST midnight, unions calls/live into online time, and only counts real earnings", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    const hostId = host.user.id;
    const ppb = await getCurrentPaisePerBean();

    await db.insert(hostOnlineSessions).values([
      { hostId, startedAt: at("2026-09-20T04:00:00Z"), endedAt: at("2026-09-20T06:00:00Z"), lastSeenAt: at("2026-09-20T06:00:00Z") },
      // Crosses IST midnight (18:30Z): 1h on the 20th, 1h on the 21st.
      { hostId, startedAt: at("2026-09-20T17:30:00Z"), endedAt: at("2026-09-20T19:30:00Z"), lastSeenAt: at("2026-09-20T19:30:00Z") },
    ]);
    // Inside the first session — adds no extra online time.
    const video = await insertCall({ userId: user.user.id, hostId, type: "video", status: "completed", createdAt: at("2026-09-20T05:30:00Z"), startedAt: at("2026-09-20T05:30:00Z"), endedAt: at("2026-09-20T05:40:00Z") });
    // Outside any session — still counts as online (+5 min).
    const voice = await insertCall({ userId: user.user.id, hostId, type: "voice", status: "completed", createdAt: at("2026-09-20T10:00:00Z"), startedAt: at("2026-09-20T10:00:00Z"), endedAt: at("2026-09-20T10:05:00Z") });
    await insertCall({ userId: user.user.id, hostId, type: "video", status: "missed", createdAt: at("2026-09-20T12:00:00Z") });
    // Live broadcast outside any session (+30 min).
    await db.insert(liveBroadcasts).values({ hostId, status: "ended", startedAt: at("2026-09-20T07:00:00Z"), endedAt: at("2026-09-20T07:30:00Z") });

    await hostCredit(hostId, 100, "call_billing", video.id, at("2026-09-20T05:35:00Z"));
    await hostCredit(hostId, 50, "call_billing", voice.id, at("2026-09-20T10:02:00Z"));
    await hostCredit(hostId, 10, "chat_message", randomUUID(), at("2026-09-20T11:00:00Z"));
    // A rejected withdrawal handing beans back is not earnings.
    await hostCredit(hostId, 999, "withdrawal", randomUUID(), at("2026-09-20T11:00:00Z"));
    // 18:40Z is already the 21st in IST.
    await hostCredit(hostId, 7, "call_billing", video.id, at("2026-09-20T18:40:00Z"));

    const res = await request(app)
      .get("/host/me/stats/daily?date=2026-09-20&tz=Asia/Kolkata")
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.dailyGoalSeconds).toBe(21600);

    expect(res.body.online.totalSeconds).toBe(2 * 3600 + 30 * 60 + 5 * 60 + 3600);
    expect(res.body.online.isOnlineNow).toBe(false);
    expect(res.body.online.asOf).toBe("2026-09-20T18:30:00.000Z");
    expect(res.body.online.sessions).toEqual([
      { start: "2026-09-20T04:00:00.000Z", end: "2026-09-20T06:00:00.000Z" },
      { start: "2026-09-20T07:00:00.000Z", end: "2026-09-20T07:30:00.000Z" },
      { start: "2026-09-20T10:00:00.000Z", end: "2026-09-20T10:05:00.000Z" },
      { start: "2026-09-20T17:30:00.000Z", end: "2026-09-20T18:30:00.000Z" },
    ]);

    expect(res.body.earnings).toEqual({
      totalPaise: 160 * ppb,
      videoCalls: { amountPaise: 100 * ppb, count: 1, seconds: 600 },
      voiceCalls: { amountPaise: 50 * ppb, count: 1, seconds: 300 },
      gifts: { amountPaise: 0, count: 0 },
      liveStreams: { amountPaise: 0, count: 1, seconds: 1800 },
      other: { amountPaise: 10 * ppb, count: 1, items: [{ label: "Chat messages", amountPaise: 10 * ppb }] },
    });
    expect(res.body.calls).toEqual({ received: 3, answered: 2, missed: 1, rejected: 0, talkSeconds: 900, avgCallSeconds: 450 });

    const summary = await request(app)
      .get("/host/me/stats/daily-summary?from=2026-09-19&to=2026-09-21&tz=Asia/Kolkata")
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.days).toEqual([
      { date: "2026-09-19", earningsPaise: 0, onlineSeconds: 0, callsCount: 0 },
      { date: "2026-09-20", earningsPaise: 160 * ppb, onlineSeconds: 12_900, callsCount: 2 },
      { date: "2026-09-21", earningsPaise: 7 * ppb, onlineSeconds: 3600, callsCount: 0 },
    ]);
  });

  it("tracks today's open session from the presence toggle, and matches the dashboard's today earnings", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 5000);
    const today = dateInTimeZone(new Date(), "Asia/Kolkata");
    const auth = { Authorization: `Bearer ${host.accessToken}` };

    await request(app).patch("/host/me/presence").set(auth).send({ isOnline: true });
    // Toggling online twice must not open a second session.
    await request(app).patch("/host/me/presence").set(auth).send({ isOnline: true });

    const giftsRes = await request(app).get("/user/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose");
    await request(app)
      .post("/user/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });

    const live = await request(app).get(`/host/me/stats/daily?date=${today}`).set(auth);
    expect(live.status).toBe(200);
    expect(live.body.online.isOnlineNow).toBe(true);
    expect(live.body.online.sessions).toHaveLength(1);
    expect(live.body.online.sessions[0].end).toBeNull();
    expect(live.body.earnings.gifts.count).toBe(1);
    expect(live.body.earnings.gifts.amountPaise).toBeGreaterThan(0);

    const dashboard = await request(app).get("/host/me/dashboard").set(auth);
    expect(live.body.earnings.totalPaise).toBe(dashboard.body.todayEarningsPaise);

    // Same-day inclusive range on the existing breakdown endpoint.
    const breakdown = await request(app).get(`/host/me/earnings/breakdown?from=${today}&to=${today}`).set(auth);
    expect(breakdown.status).toBe(200);
    expect(breakdown.body.bySource.gifts).toBe(rose.pricePaise);

    await request(app).patch("/host/me/presence").set(auth).send({ isOnline: false });
    const after = await request(app).get(`/host/me/stats/daily?date=${today}`).set(auth);
    expect(after.body.online.isOnlineNow).toBe(false);
    expect(after.body.online.sessions[0].end).not.toBeNull();
  });

  it("does not count a withdrawal reversal as today's dashboard earnings", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    await hostCredit(host.user.id, 500, "withdrawal", randomUUID(), new Date());

    const dashboard = await request(app).get("/host/me/dashboard").set("Authorization", `Bearer ${host.accessToken}`);
    expect(dashboard.body.todayEarningsPaise).toBe(0);
  });

  it("closes a session left open by a restart at the last time the host was seen", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const lastSeenAt = at("2026-09-22T08:00:00Z");
    await db.insert(hostOnlineSessions).values({ hostId: host.user.id, startedAt: at("2026-09-22T07:00:00Z"), lastSeenAt });

    // This process never marked the host online in memory — same as after a restart.
    await sweepOnlineSessions();

    const [session] = await db.select().from(hostOnlineSessions).where(eq(hostOnlineSessions.hostId, host.user.id));
    expect(session.endedAt).toEqual(lastSeenAt);
  });

  it("rejects bad input with 400", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const auth = { Authorization: `Bearer ${host.accessToken}` };
    const tomorrow = addDays(dateInTimeZone(new Date(), "Asia/Kolkata"), 1);

    for (const query of [`date=${tomorrow}`, "date=2026-02-30", "date=27-09-2026", "date=2026-09-20&tz=Mars/Base"]) {
      const res = await request(app).get(`/host/me/stats/daily?${query}`).set(auth);
      expect(res.status, query).toBe(400);
    }
    for (const query of ["from=2026-08-01&to=2026-09-01", "from=2026-09-20&to=2026-09-19", `from=2026-09-20&to=${tomorrow}`]) {
      const res = await request(app).get(`/host/me/stats/daily-summary?${query}`).set(auth);
      expect(res.status, query).toBe(400);
    }
  });
});

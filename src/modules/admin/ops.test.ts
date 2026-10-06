import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";
import { DEFAULT_APP_SETTINGS } from "../settings/appSettings.service";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function onlineHost(app: ReturnType<typeof createApp>) {
  const host = await registerAndLogin(app, "host");
  await request(app).patch("/host/me/presence").set(bearer(host.accessToken)).send({ isOnline: true });
  return host;
}

describe("Admin ops: calls", () => {
  it("lists live calls, force-ends one with a reason, and shows it in the history", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const host = await onlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 50_000);

    const placed = await request(app).post("/user/calls").set(bearer(user.accessToken)).send({ hostId: host.user.id });
    const callId = placed.body.callId as string;

    const live = await request(app).get("/admin/calls/live").set(bearer(admin.accessToken));
    expect(live.status).toBe(200);
    expect(live.body.calls.find((c: { id: string }) => c.id === callId)).toMatchObject({ status: "ringing", hostId: host.user.id });

    await request(app).post(`/host/calls/${callId}/accept`).set(bearer(host.accessToken));
    const noReason = await request(app).post(`/admin/calls/${callId}/end`).set(bearer(admin.accessToken)).send({});
    expect(noReason.status).toBe(400);

    const ended = await request(app).post(`/admin/calls/${callId}/end`).set(bearer(admin.accessToken)).send({ reason: "Abusive behaviour" });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ id: callId, status: "completed", endReason: "ended_by_admin" });
    const again = await request(app).post(`/admin/calls/${callId}/end`).set(bearer(admin.accessToken)).send({ reason: "Again" });
    expect(again.status).toBe(409);

    const history = await request(app).get(`/admin/calls?hostId=${host.user.id}`).set(bearer(admin.accessToken));
    expect(history.body).toMatchObject({ total: 1, page: 1, pageSize: 20, hasMore: false });
    expect(history.body.calls[0]).toMatchObject({ id: callId, userId: user.user.id, endReason: "ended_by_admin" });
    expect(history.body.calls[0]).toHaveProperty("durationQuality");

    const detail = await request(app).get(`/admin/calls/${callId}`).set(bearer(admin.accessToken));
    expect(detail.body.id).toBe(callId);
    expect((await request(app).get(`/host/calls/${callId}`).set(bearer(host.accessToken))).body.status).toBe("completed");

    const audit = await request(app).get("/admin/audit-log").set(bearer((await registerAndLoginAdmin()).accessToken));
    const entry = audit.body.entries.find((e: { action: string; targetId: string }) => e.action === "call.force_end" && e.targetId === callId);
    expect(entry).toBeTruthy();
  });
});

describe("Admin ops: user wallet & refunds", () => {
  it("shows the signed ledger and applies refunds and corrections atomically, never below ₹0", async () => {
    const app = createApp();
    const finance = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const user = await registerAndLogin(app, "user");
    const otherUser = await registerAndLogin(app, "user");
    const host = await onlineHost(app);
    await fundUserWallet(app, user.accessToken, 10_000);
    await fundUserWallet(app, otherUser.accessToken, 10_000);
    const otherCall = await request(app).post("/user/calls").set(bearer(otherUser.accessToken)).send({ hostId: host.user.id });
    await request(app).post(`/user/calls/${otherCall.body.callId}/end`).set(bearer(otherUser.accessToken));
    const ownCall = await request(app).post("/user/calls").set(bearer(user.accessToken)).send({ hostId: host.user.id });
    await request(app).post(`/user/calls/${ownCall.body.callId}/end`).set(bearer(user.accessToken));

    const refund = await request(app)
      .post(`/admin/users/${user.user.id}/adjustments`)
      .set(bearer(finance.accessToken))
      .send({ amountPaise: 1_200, reason: "Call dropped after 20s", reference: ownCall.body.callId });
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({ type: "refund", balanceBeforePaise: 10_000, balanceAfterPaise: 11_200 });

    const correction = await request(app)
      .post(`/admin/users/${user.user.id}/adjustments`)
      .set(bearer(finance.accessToken))
      .send({ amountPaise: -200, reason: "Duplicate goodwill credit" });
    expect(correction.body).toMatchObject({ type: "adjustment", balanceAfterPaise: 11_000 });

    const tooMuch = await request(app)
      .post(`/admin/users/${user.user.id}/adjustments`)
      .set(bearer(finance.accessToken))
      .send({ amountPaise: -11_001, reason: "Would go negative" });
    expect(tooMuch.status).toBe(422);
    const shortReason = await request(app).post(`/admin/users/${user.user.id}/adjustments`).set(bearer(finance.accessToken)).send({ amountPaise: 100, reason: "oops" });
    expect(shortReason.status).toBe(400);
    const wrongCall = await request(app)
      .post(`/admin/users/${user.user.id}/adjustments`)
      .set(bearer(finance.accessToken))
      .send({ amountPaise: 100, reason: "Refund for that call", reference: otherCall.body.callId });
    expect(wrongCall.status).toBe(400);

    const wallet = await request(app).get(`/admin/users/${user.user.id}/wallet`).set(bearer(finance.accessToken));
    expect(wallet.body.balancePaise).toBe(11_000);
    expect(wallet.body.transactions.slice(0, 2)).toEqual([
      expect.objectContaining({ type: "adjustment", amountPaise: -200, reason: "Duplicate goodwill credit", balanceAfterPaise: 11_000 }),
      expect.objectContaining({ type: "refund", amountPaise: 1_200, reference: ownCall.body.callId }),
    ]);

    // The ledger still explains every balance.
    const reconciliation = await request(app).get("/admin/reconciliation").set(bearer(finance.accessToken));
    expect(JSON.stringify(reconciliation.body.userDrift)).not.toContain(user.user.id);

    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    expect((await request(app).get(`/admin/users/${user.user.id}/wallet`).set(bearer(moderator.accessToken))).status).toBe(403);
  });
});

describe("Admin ops: live monitor and gifts", () => {
  it("shows title, comments and gift beans, records gift requests, and ends a broadcast with a reason", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const host = await registerAndLogin(app, "host");
    const viewer = await registerAndLogin(app, "user");
    await fundUserWallet(app, viewer.accessToken, 100_000);

    const started = await request(app).post("/host/live/broadcasts").set(bearer(host.accessToken)).send({ title: "Evening chat" });
    const broadcastId = started.body.broadcastId as string;
    await request(app).post(`/user/live/broadcasts/${broadcastId}/join`).set(bearer(viewer.accessToken));
    await request(app).post(`/user/live/broadcasts/${broadcastId}/chat`).set(bearer(viewer.accessToken)).send({ content: "Hi!" });
    await request(app).post(`/host/live/broadcasts/${broadcastId}/chat`).set(bearer(host.accessToken)).send({ content: "Hello" });
    const tooLong = await request(app)
      .post(`/user/live/broadcasts/${broadcastId}/chat`)
      .set(bearer(viewer.accessToken))
      .send({ content: "x".repeat(DEFAULT_APP_SETTINGS.liveCommentMaxLength + 1) });
    expect(tooLong.status).toBe(400);

    const gifts = await request(app).get("/user/gifts").set(bearer(viewer.accessToken));
    const giftId = gifts.body.gifts[0].id as string;

    // Host asks; the user declines; the host asks again and the user sends a gift.
    await request(app).post("/host/gifts/request").set(bearer(host.accessToken)).send({ userId: viewer.user.id, suggestedGiftId: giftId, note: "Please" });
    await request(app).post("/user/gifts/request/decline").set(bearer(viewer.accessToken)).send({ hostId: host.user.id });
    await request(app).post("/host/gifts/request").set(bearer(host.accessToken)).send({ userId: viewer.user.id });
    const sent = await request(app)
      .post("/user/gifts/send")
      .set(bearer(viewer.accessToken))
      .send({ recipientId: host.user.id, giftId, context: "live", contextId: broadcastId });
    expect(sent.status).toBe(201);

    const monitor = await request(app).get("/admin/live/broadcasts?status=live").set(bearer(admin.accessToken));
    expect(monitor.body.broadcasts.find((b: { id: string }) => b.id === broadcastId)).toMatchObject({
      title: "Evening chat",
      hostId: host.user.id,
      viewerCount: 1,
      commentsCount: 2,
      giftBeans: sent.body.beansCredited,
    });

    const requests = await request(app).get(`/admin/gifts/requests?hostId=${host.user.id}`).set(bearer(admin.accessToken));
    expect(requests.body.total).toBe(2);
    expect(requests.body.requests.map((r: { status: string }) => r.status)).toEqual(["accepted", "declined"]);
    expect(requests.body.requests[1]).toMatchObject({ note: "Please", userId: viewer.user.id, suggestedGiftId: giftId });

    const transactions = await request(app).get(`/admin/gifts/transactions?hostId=${host.user.id}&context=live`).set(bearer(admin.accessToken));
    expect(transactions.body.transactions[0]).toMatchObject({ context: "live", contextId: broadcastId, senderId: viewer.user.id, beans: sent.body.beansCredited });

    const ended = await request(app).post(`/admin/live/broadcasts/${broadcastId}/end`).set(bearer(admin.accessToken)).send({ reason: "Rules" });
    expect(ended.body.status).toBe("ended");
  });
});

describe("Admin ops: security events", () => {
  it("logs typed events, escalates only on capture evidence, and lists repeat offenders", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const user = await registerAndLogin(app, "user");
    const log = (type?: string) =>
      request(app).post("/user/moderation/capture-event").set(bearer(user.accessToken)).send({ context: "call", ...(type ? { type } : {}) });

    for (let i = 0; i < 5; i++) {
      const res = await log("PAGE_HIDDEN");
      expect(res.body.policyAction).toBe("logged");
    }
    expect((await log("SCREENSHOT_ATTEMPT")).body).toMatchObject({ totalCaptureEvents: 1, policyAction: "logged" });
    expect((await log()).body.totalCaptureEvents).toBe(2); // untyped = an older app's capture attempt

    const all = await request(app).get(`/admin/security-events?accountId=${user.user.id}`).set(bearer(admin.accessToken));
    expect(all.body.total).toBe(7);
    expect(all.body.repeatOffenders).toEqual([expect.objectContaining({ accountId: user.user.id, role: "user", count: 7 })]);
    const screenshots = await request(app).get(`/admin/security-events?accountId=${user.user.id}&type=SCREENSHOT_ATTEMPT`).set(bearer(admin.accessToken));
    expect(screenshots.body.total).toBe(2); // includes the untyped one
    expect(screenshots.body.events.every((e: { type: string }) => e.type === "SCREENSHOT_ATTEMPT")).toBe(true);
  });
});

describe("Admin ops: host performance, reported chat, insights", () => {
  it("summarises a host, shows the chat behind a report (audit-logged), and returns 14 days of insights", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const host = await onlineHost(app);
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 50_000);

    const call = await request(app).post("/user/calls").set(bearer(user.accessToken)).send({ hostId: host.user.id });
    await request(app).post(`/host/calls/${call.body.callId}/reject`).set(bearer(host.accessToken));

    const summary = await request(app).get(`/admin/hosts/${host.user.id}/stats/summary`).set(bearer(admin.accessToken));
    expect(summary.status).toBe(200);
    expect(summary.body.calls).toMatchObject({ received: 1, answered: 0, rejected: 1 });
    expect(summary.body.earnings).toMatchObject({ totalPaise: 0, callsPaise: 0 });
    expect(summary.body.quality).toEqual({ bad: 0, good: 0, excellent: 0 });
    const days = await request(app).get(`/admin/hosts/${host.user.id}/stats/daily-summary`).set(bearer(admin.accessToken));
    expect(days.body.days).toHaveLength(14);
    expect((await request(app).get(`/admin/hosts/${user.user.id}/stats/summary`).set(bearer(admin.accessToken))).status).toBe(404);

    await request(app).post("/user/chat/messages").set(bearer(user.accessToken)).send({ recipientId: host.user.id, content: "Hi there" });
    await request(app).post("/host/chat/messages").set(bearer(host.accessToken)).send({ recipientId: user.user.id, content: "Hello" });
    const report = await request(app)
      .post("/user/moderation/reports")
      .set(bearer(user.accessToken))
      .send({ targetType: "host", targetId: host.user.id, reason: "Rude" });
    const conversation = await request(app).get(`/admin/moderation/${report.body.id}/conversation`).set(bearer(admin.accessToken));
    expect(conversation.status).toBe(200);
    expect(conversation.body.messages.map((m: { content: string; senderRole: string }) => [m.senderRole, m.content])).toEqual([
      ["user", "Hi there"],
      ["host", "Hello"],
    ]);

    const insights = await request(app).get("/admin/dashboard/insights").set(bearer(admin.accessToken));
    expect(insights.status).toBe(200);
    expect(insights.body.revenueSeries).toHaveLength(14);
    expect(insights.body.callsByStatus.rejected).toBeGreaterThanOrEqual(1);
    expect(insights.body.missedRate).toBeGreaterThanOrEqual(0);
    expect(insights.body.missedRate).toBeLessThanOrEqual(1);
    const badRange = await request(app).get("/admin/dashboard/insights?from=2026-09-10&to=2026-09-01").set(bearer(admin.accessToken));
    expect(badRange.status).toBe(400);
  });
});

describe("Admin ops: app settings", () => {
  it("validates, saves and exposes the settings on GET /config", async () => {
    const app = createApp();
    const finance = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const user = await registerAndLogin(app, "user");
    const save = (body: object) => request(app).post("/admin/config/app-settings").set(bearer(finance.accessToken)).send(body);

    expect((await request(app).get("/admin/config/app-settings").set(bearer(finance.accessToken))).body).toEqual(DEFAULT_APP_SETTINGS);
    const crossedBands = await save({ ...DEFAULT_APP_SETTINGS, callQuality: { goodFromSeconds: 600, excellentFromSeconds: 300 } });
    expect(crossedBands.status).toBe(422);
    const overADay = await save({ ...DEFAULT_APP_SETTINGS, dailyGoalSeconds: 90_000 });
    expect(overADay.status).toBe(422);

    // The settings are global and the test DB is shared — only change values
    // nothing else in the suite depends on, and put them back.
    try {
      const saved = await save({ ...DEFAULT_APP_SETTINGS, messagePrice: { minPaise: 600, maxPaise: 12_000 }, reason: "Raise the floor" });
      expect(saved.status).toBe(201);
      const config = await request(app).get("/user/config").set(bearer(user.accessToken));
      expect(config.body.appSettings.messagePrice).toEqual({ minPaise: 600, maxPaise: 12_000 });
    } finally {
      await save(DEFAULT_APP_SETTINGS);
    }
  });
});

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

describe("Moderation reports (BR-MOD-04/05)", () => {
  it("lets a user file a report, and an admin resolve it", async () => {
    const app = createApp();
    const reporter = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const filed = await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${reporter.accessToken}`)
      .send({ targetType: "host", targetId: host.user.id, reason: "Inappropriate behavior on call" });
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe("pending");

    const admin = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const queue = await request(app).get("/admin/moderation?status=pending").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.reports.some((r: { id: string }) => r.id === filed.body.id)).toBe(true);

    const resolved = await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "resolved", note: "Warned the host" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolvedByAdminId).toBe(admin.user.id);

    const resolveAgain = await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "dismissed" });
    expect(resolveAgain.status).toBe(409);
  });

  it("a moderation report can lead to a real account suspension as a separate admin action", async () => {
    const app = createApp();
    const reporter = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");

    const filed = await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${reporter.accessToken}`)
      .send({ targetType: "host", targetId: host.user.id, reason: "Scamming users off-platform" });

    const admin = await registerAndLoginAdmin();
    await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "resolved" });

    const suspended = await request(app)
      .post(`/admin/users/${host.user.id}/status`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ status: "banned", reason: `Moderation report ${filed.body.id}` });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("banned");
  });
});

describe("Capture events (BR-MOD-03)", () => {
  it("logs quietly, then warns, then auto-escalates to the moderation queue at the threshold — never auto-suspends", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");

    const first = await request(app)
      .post("/moderation/capture-event")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ context: "call" });
    expect(first.status).toBe(201);
    expect(first.body.policyAction).toBe("logged");
    expect(first.body.totalCaptureEvents).toBe(1);

    const second = await request(app)
      .post("/moderation/capture-event")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ context: "live" });
    expect(second.body.policyAction).toBe("warning");

    await request(app)
      .post("/moderation/capture-event")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ context: "call" });

    const fourth = await request(app)
      .post("/moderation/capture-event")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ context: "call" });
    expect(fourth.body.policyAction).toBe("escalated_for_review");
    expect(fourth.body.totalCaptureEvents).toBe(4);

    const admin = await registerAndLoginAdmin();
    const queue = await request(app).get("/admin/moderation?status=pending").set("Authorization", `Bearer ${admin.accessToken}`);
    const autoReport = queue.body.reports.find((r: { targetId: string }) => r.targetId === user.user.id);
    expect(autoReport).toBeTruthy();
    expect(autoReport.reason).toMatch(/4 screen-capture attempts/i);

    // Resolving the report still doesn't suspend anyone by itself — that
    // stays a separate, explicit admin decision (same as any other report).
    const account = await request(app).get("/me").set("Authorization", `Bearer ${user.accessToken}`);
    expect(account.body.status).toBe("active");

    const events = await request(app).get("/admin/capture-events?limit=10").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(events.status).toBe(200);
    expect(events.body.events.filter((e: { userId: string }) => e.userId === user.user.id)).toHaveLength(4);
  });
});

describe("Moderation: combined Dismiss/Warn/Suspend/Ban action (admin design follow-up)", () => {
  it("warns an account without changing its status", async () => {
    const app = createApp();
    const reporter = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const filed = await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${reporter.accessToken}`)
      .send({ targetType: "host", targetId: host.user.id, reason: "Borderline behavior" });

    const admin = await registerAndLoginAdmin();
    const resolved = await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "resolved", accountAction: "warn", note: "First warning" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");

    const hostDetail = await request(app).get("/me").set("Authorization", `Bearer ${host.accessToken}`);
    expect(hostDetail.body.status).toBe("active"); // unaffected by a warning

    const auditLog = await request(app).get("/admin/audit-log?limit=5").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(auditLog.body.entries.some((e: { action: string }) => e.action === "moderation.warn")).toBe(true);
  });

  it("suspends the account as part of resolving the report, in one call", async () => {
    const app = createApp();
    const reporter = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    const filed = await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${reporter.accessToken}`)
      .send({ targetType: "host", targetId: host.user.id, reason: "Serious violation" });

    const admin = await registerAndLoginAdmin();
    const resolved = await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "resolved", accountAction: "suspend" });
    expect(resolved.status).toBe(200);

    const hostDetail = await request(app).get("/me").set("Authorization", `Bearer ${host.accessToken}`);
    expect(hostDetail.body.status).toBe("suspended");
  });

  it("rejects an account action against a report that targets content, not an account", async () => {
    const app = createApp();
    const reporter = await registerAndLogin(app, "user");
    const filed = await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${reporter.accessToken}`)
      .send({ targetType: "live_broadcast", targetId: "00000000-0000-0000-0000-000000000000", reason: "False information" });

    const admin = await registerAndLoginAdmin();
    const res = await request(app)
      .post(`/admin/moderation/${filed.body.id}/resolve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ action: "resolved", accountAction: "ban" });
    expect(res.status).toBe(400);

    // The report must still be pending — the bad accountAction was
    // rejected before resolving it, not after.
    const stillPending = await request(app)
      .get("/admin/moderation?status=pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(stillPending.body.reports.some((r: { id: string }) => r.id === filed.body.id)).toBe(true);
  });
});

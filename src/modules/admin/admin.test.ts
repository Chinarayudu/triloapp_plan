import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, randomPhone, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

// Submits KYC without a real S3 round trip — /me/kyc only validates each
// key belongs to the caller (users.routes.ts), it never checks the object
// actually exists in S3, so fake keys are enough to drive kycStatus into
// "pending" for these admin-decision tests.
async function submitFakeKyc(app: ReturnType<typeof createApp>, accessToken: string, userId: string): Promise<void> {
  const res = await request(app)
    .post("/me/kyc")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      documents: [
        { documentType: "id_front", key: `kyc/${userId}/front.pdf` },
        { documentType: "selfie", key: `kyc/${userId}/selfie.pdf` },
      ],
    });
  expect(res.status).toBe(200);
  expect(res.body.kycStatus).toBe("pending");
}

describe("Admin: KYC approval queue", () => {
  it("lists pending KYC, approves it, and verifies age when DOB is on file", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    await request(app)
      .patch("/me")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ dob: "1995-05-05" });
    await submitFakeKyc(app, host.accessToken, host.user.id);

    const admin = await registerAndLoginAdmin();
    const pending = await request(app).get("/admin/kyc/pending").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(pending.status).toBe(200);
    expect(pending.body.submissions.some((s: { userId: string }) => s.userId === host.user.id)).toBe(true);

    const decided = await request(app)
      .post(`/admin/kyc/${host.user.id}/decision`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ decision: "approve" });
    expect(decided.status).toBe(200);
    expect(decided.body.kycStatus).toBe("approved");
    expect(decided.body.ageVerified).toBe(true);
  });

  it("rejects KYC with a reason, and refuses to decide a non-pending submission again", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    await submitFakeKyc(app, host.accessToken, host.user.id);

    const admin = await registerAndLoginAdmin();
    const rejected = await request(app)
      .post(`/admin/kyc/${host.user.id}/decision`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ decision: "reject", reason: "Document unreadable" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.kycStatus).toBe("rejected");

    const again = await request(app)
      .post(`/admin/kyc/${host.user.id}/decision`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ decision: "approve" });
    expect(again.status).toBe(409);
  });

  it("blocks a non-admin from the KYC queue", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const res = await request(app).get("/admin/kyc/pending").set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe("Admin: sub-admin RBAC (BR-ADM-03)", () => {
  it("lets a sub-admin with the right permission through, and blocks one without it", async () => {
    const app = createApp();
    const financeOnly = await registerAndLoginAdmin("sub_admin", ["finance"]);

    const allowed = await request(app)
      .get("/admin/config/commission")
      .set("Authorization", `Bearer ${financeOnly.accessToken}`);
    expect(allowed.status).toBe(200);

    const blocked = await request(app)
      .get("/admin/kyc/pending")
      .set("Authorization", `Bearer ${financeOnly.accessToken}`);
    expect(blocked.status).toBe(403);
  });

  it("only a full admin (not a sub-admin) can create sub-admins, and the new sub-admin can log in with the set password", async () => {
    const app = createApp();
    const subAdmin = await registerAndLoginAdmin("sub_admin", ["finance", "moderation", "analytics"]);
    const email = `subadmin-${randomPhone().slice(1)}@example.com`;

    const blocked = await request(app)
      .post("/admin/sub-admins")
      .set("Authorization", `Bearer ${subAdmin.accessToken}`)
      .send({ phone: randomPhone(), email, password: "a-strong-password", permissions: ["finance"] });
    expect(blocked.status).toBe(403);

    const admin = await registerAndLoginAdmin();
    const created = await request(app)
      .post("/admin/sub-admins")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ phone: randomPhone(), email, password: "a-strong-password", permissions: ["moderation"] });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("sub_admin");
    expect(created.body.permissions).toEqual(["moderation"]);

    const login = await request(app).post("/auth/admin/login").send({ email, password: "a-strong-password" });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(created.body.id);

    const updated = await request(app)
      .patch(`/admin/sub-admins/${created.body.id}/permissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ permissions: ["finance", "analytics"] });
    expect(updated.status).toBe(200);
    expect(updated.body.permissions).toEqual(["finance", "analytics"]);
  });
});

describe("Admin: pricing/economics config (BR-ADM-02)", () => {
  // Commission/slab config is real global state — other suites (gifts,
  // calls billing, withdrawals) assert exact money math against the
  // seeded defaults (20% commission; slabs 0-49999@1, 50000+@2 paise/bean).
  // Since these are append-only "latest effectiveFrom wins" tables shared
  // across the whole test DB (BUG_HISTORY.md's "test against the real
  // dependency" philosophy, no per-test DB isolation), every test here
  // restores the seeded value immediately after asserting the mutation
  // worked — otherwise this file would silently break every other suite
  // that runs after it.
  it("creates a new commission config version without touching the old one", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    const before = await request(app).get("/admin/config/commission").set("Authorization", `Bearer ${admin.accessToken}`);
    const countBefore = before.body.configs.length;

    const created = await request(app)
      .post("/admin/config/commission")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ basisPoints: 2500 });
    expect(created.status).toBe(201);
    expect(created.body.basisPoints).toBe(2500);

    const after = await request(app).get("/admin/config/commission").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(after.body.configs.length).toBe(countBefore + 1);

    await request(app)
      .post("/admin/config/commission")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ basisPoints: 2000 }); // restore the seeded default (db/seed.ts)
  });

  // A host-specific override, unlike global, is scoped to one host id —
  // no restoration needed, it can't leak into any other suite's money math.
  it("applies a per-host commission override (BR-COM-03) instead of the global rate", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const host = await registerAndLogin(app, "host");
    const sender = await registerAndLogin(app, "user");

    const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${sender.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose"); // ₹10 = 1000 paise

    await fundUserWallet(app, sender.accessToken, rose.pricePaise);
    const beforeOverride = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });
    expect(beforeOverride.body.beansCredited).toBe(800); // seeded global 20%: 1000 - 200 = 800

    const override = await request(app)
      .post("/admin/config/commission")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ basisPoints: 500, hostId: host.user.id }); // 5% just for this host
    expect(override.status).toBe(201);
    expect(override.body.hostId).toBe(host.user.id);

    await fundUserWallet(app, sender.accessToken, rose.pricePaise);
    const afterOverride = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });
    expect(afterOverride.body.beansCredited).toBe(950); // 5%: 1000 - 50 = 950

    const otherHost = await registerAndLogin(app, "host");
    await fundUserWallet(app, sender.accessToken, rose.pricePaise);
    const otherHostGift = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${sender.accessToken}`)
      .send({ recipientId: otherHost.user.id, giftId: rose.id });
    expect(otherHostGift.body.beansCredited).toBe(800); // unaffected — still the global rate

    const filtered = await request(app)
      .get(`/admin/config/commission?hostId=${host.user.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(filtered.body.configs).toHaveLength(1);
    expect(filtered.body.configs[0].basisPoints).toBe(500);
  });

  it("replaces the withdrawal slab set", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    const res = await request(app)
      .post("/admin/config/withdrawal-slabs")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        slabs: [
          { minBeans: 0, maxBeans: 9999, paisePerBean: 1 },
          { minBeans: 10000, maxBeans: null, paisePerBean: 3 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.configs).toHaveLength(2);

    await request(app)
      .post("/admin/config/withdrawal-slabs")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        slabs: [
          { minBeans: 0, maxBeans: 49999, paisePerBean: 1 },
          { minBeans: 50000, maxBeans: null, paisePerBean: 2 },
        ],
      }); // restore the seeded default (db/seed.ts)
  });
});

describe("Admin: 18+ toggle (BR-MOD-01)", () => {
  it("is restricted to full admins only, not sub-admins of any permission (design: super-admin-only)", async () => {
    const app = createApp();
    const financeOnly = await registerAndLoginAdmin("sub_admin", ["finance"]);

    const blocked = await request(app)
      .get("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${financeOnly.accessToken}`);
    expect(blocked.status).toBe(403);

    // Even a sub-admin with the moderation permission is blocked — 18+ mode
    // is full-admin-only, not gated by the moderation permission grant.
    const moderationOnly = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const stillBlocked = await request(app)
      .get("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${moderationOnly.accessToken}`);
    expect(stillBlocked.status).toBe(403);

    const fullAdmin = await registerAndLoginAdmin();
    const allowed = await request(app)
      .get("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${fullAdmin.accessToken}`);
    expect(allowed.status).toBe(200);
  });

  it("toggles the global flag, visible via the public read endpoint, then restores the seeded default", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    // Doesn't assert the "before" value against the seeded default — this
    // is real shared global state (like commission/slab config above), and
    // another test file's concurrently-running adult-mode test could
    // legitimately have it flipped on at this exact instant. Only the
    // causal effect of this test's own writes is asserted.
    const created = await request(app)
      .post("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: true });
    expect(created.status).toBe(201);

    const after = await request(app).get("/live/adult-mode").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(after.body.enabled).toBe(true);

    await request(app)
      .post("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: false }); // restore the seeded default
  });
});

describe("Admin: gift catalog CRUD (BR-ADM-02)", () => {
  it("creates a gift, deactivates it, and it disappears from the public catalog", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    const created = await request(app)
      .post("/admin/gifts")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: "Diamond", pricePaise: 50000 });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(true);

    const user = await registerAndLogin(app, "user");
    const catalogBefore = await request(app).get("/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    expect(catalogBefore.body.gifts.some((g: { id: string }) => g.id === created.body.id)).toBe(true);

    const deactivated = await request(app)
      .patch(`/admin/gifts/${created.body.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ active: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.active).toBe(false);

    const catalogAfter = await request(app).get("/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    expect(catalogAfter.body.gifts.some((g: { id: string }) => g.id === created.body.id)).toBe(false);

    const adminView = await request(app).get("/admin/gifts").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminView.body.gifts.some((g: { id: string }) => g.id === created.body.id)).toBe(true);
  });
});

describe("Admin: account suspension (BR-ACC-05, BR-MOD-05)", () => {
  it("suspends a user, revoking their refresh token and blocking re-login", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const admin = await registerAndLoginAdmin();

    const suspended = await request(app)
      .post(`/admin/users/${user.user.id}/status`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ status: "suspended", reason: "Suspicious activity" });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("suspended");

    const refreshAttempt = await request(app).post("/auth/token/refresh").send({ refreshToken: user.refreshToken });
    expect(refreshAttempt.status).toBe(401);

    const loginAttempt = await request(app).post("/auth/otp/request").send({ phone: user.user.phone });
    const verifyAttempt = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: user.user.phone, code: loginAttempt.body.devCode, role: "user" });
    expect(verifyAttempt.status).toBe(403);
  });

  it("refuses to suspend an admin account through this endpoint", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const otherAdmin = await registerAndLoginAdmin();

    const res = await request(app)
      .post(`/admin/users/${otherAdmin.user.id}/status`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ status: "banned" });
    expect(res.status).toBe(400);
  });
});

describe("Admin: audit log and dashboard (BR-ADM-01, BR-ADM-04)", () => {
  it("logs an admin action and it shows up in the audit log", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    // Gift creation is used here (rather than a commission/slab config
    // change) specifically because it doesn't perturb the shared money
    // math other suites assert against — see the restoration comment in
    // the "pricing/economics config" describe block above.
    await request(app)
      .post("/admin/gifts")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: "Audit Log Test Gift", pricePaise: 100 });

    const log = await request(app).get("/admin/audit-log").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(log.status).toBe(200);
    expect(log.body.entries[0].action).toBe("gift.create");
    expect(log.body.entries[0].adminId).toBe(admin.user.id);
  });

  it("filters the audit log by admin and by date range", async () => {
    const app = createApp();
    const adminA = await registerAndLoginAdmin();
    const adminB = await registerAndLoginAdmin();

    await request(app)
      .post("/admin/gifts")
      .set("Authorization", `Bearer ${adminA.accessToken}`)
      .send({ name: "Admin A's gift", pricePaise: 100 });
    await request(app)
      .post("/admin/gifts")
      .set("Authorization", `Bearer ${adminB.accessToken}`)
      .send({ name: "Admin B's gift", pricePaise: 100 });

    const filteredByAdmin = await request(app)
      .get(`/admin/audit-log?adminId=${adminA.user.id}`)
      .set("Authorization", `Bearer ${adminA.accessToken}`);
    expect(filteredByAdmin.status).toBe(200);
    expect(filteredByAdmin.body.entries.every((e: { adminId: string }) => e.adminId === adminA.user.id)).toBe(true);
    expect(filteredByAdmin.body.entries.some((e: { targetId: string }) => e.targetId)).toBe(true);

    const pastWindow = await request(app)
      .get("/admin/audit-log?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z")
      .set("Authorization", `Bearer ${adminA.accessToken}`);
    expect(pastWindow.status).toBe(200);
    expect(pastWindow.body.entries).toHaveLength(0);
  });

  it("records the previous value alongside the new one for a config change", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    const created = await request(app)
      .post("/admin/config/beans-rate")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ paisePerBean: 1 }); // re-applies the seeded default — no lasting drift for other suites
    expect(created.status).toBe(201);

    const log = await request(app).get("/admin/audit-log?limit=5").set("Authorization", `Bearer ${admin.accessToken}`);
    const entry = log.body.entries.find((e: { action: string }) => e.action === "config.beans_earn.create");
    expect(entry).toBeTruthy();
    const metadata = JSON.parse(entry.metadata);
    expect(metadata).toEqual({ previous: 1, new: 1 });
  });

  it("returns real dashboard numbers reflecting a completed money movement, scoped to the selected period", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 300000);

    // Send a stack of the most expensive gift (not just one Rose) so this
    // host's total dominates the ranking — topEarningHosts is a top-10 cut,
    // and the full suite runs test files concurrently against the same DB,
    // so other files' hosts can otherwise crowd this one out of the top 10.
    const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    const crown = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Crown");
    const giftSendCount = 10;
    for (let i = 0; i < giftSendCount; i++) {
      const sent = await request(app)
        .post("/gifts/send")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ recipientId: host.user.id, giftId: crown.id });
      expect(sent.status).toBe(201);
    }
    const totalGiftedPaise = crown.pricePaise * giftSendCount;

    const admin = await registerAndLoginAdmin();
    const dashboard = await request(app).get("/admin/dashboard").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.totalUsers).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.activeUsers).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.totalHosts).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.activeHosts).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.revenuePaise).toBeGreaterThanOrEqual(totalGiftedPaise);
    expect(Array.isArray(dashboard.body.series)).toBe(true);

    const topHost = dashboard.body.topEarningHosts.find((h: { hostId: string }) => h.hostId === host.user.id);
    expect(topHost).toBeTruthy();
    expect(topHost.earningsPaise).toBeGreaterThanOrEqual(totalGiftedPaise);
    expect(topHost.status).toBe("active");

    // A period entirely before this gift happened must exclude it.
    const past = await request(app)
      .get("/admin/dashboard?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(past.status).toBe(200);
    expect(past.body.topEarningHosts.find((h: { hostId: string }) => h.hostId === host.user.id)).toBeUndefined();
  });
});

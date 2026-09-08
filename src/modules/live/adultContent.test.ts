import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

// Age-verification (ageVerified) only becomes true via a real KYC approval
// with a dob on file (admin.service.ts's decideKyc, BR-ACC-04) — same
// mechanism used across the Phase 9 admin tests, reused here rather than
// inventing a shortcut.
async function verifyAge(app: ReturnType<typeof createApp>, accessToken: string, userId: string): Promise<void> {
  await request(app)
    .patch("/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ dob: "1990-01-01" });
  await request(app)
    .post("/me/kyc")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ documents: [{ documentType: "id_front", key: `kyc/${userId}/front.pdf` }] });

  const admin = await registerAndLoginAdmin();
  const decided = await request(app)
    .post(`/admin/kyc/${userId}/decision`)
    .set("Authorization", `Bearer ${admin.accessToken}`)
    .send({ decision: "approve" });
  expect(decided.body.ageVerified).toBe(true);
}

describe("Live broadcasting: 18+ content gating (BR-MOD-01/02)", () => {
  it("blocks starting adult content while the platform-wide toggle is off", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");

    // adult_mode_configs is real shared global state (same as commission/
    // beans-rate/slab config) — set it explicitly rather than trusting the
    // seeded default, since a concurrently-running test file (e.g.
    // admin.test.ts's toggle test) could otherwise have it flipped on at
    // this exact instant.
    const admin = await registerAndLoginAdmin();
    await request(app)
      .post("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: false });

    const res = await request(app)
      .post("/live/broadcasts")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isAdultContent: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled platform-wide/i);
  });

  it("blocks an unverified host from starting adult content even with the toggle on, then allows it once verified, and gates viewing by the viewer's own age verification", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();

    const enabled = await request(app)
      .post("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: true });
    expect(enabled.status).toBe(201);

    const modeStatus = await request(app).get("/live/adult-mode").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(modeStatus.body.enabled).toBe(true);

    const host = await registerAndLogin(app, "host");
    const unverifiedAttempt = await request(app)
      .post("/live/broadcasts")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isAdultContent: true });
    expect(unverifiedAttempt.status).toBe(403);
    expect(unverifiedAttempt.body.error).toMatch(/age verification required/i);

    await verifyAge(app, host.accessToken, host.user.id);

    const started = await request(app)
      .post("/live/broadcasts")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ isAdultContent: true });
    expect(started.status).toBe(201);
    expect(started.body.isAdultContent).toBe(true);
    expect(started.body.secureMode).toBe(true);
    const broadcastId = started.body.broadcastId;

    const unverifiedViewer = await registerAndLogin(app, "user");
    const list1 = await request(app).get("/live/broadcasts").set("Authorization", `Bearer ${unverifiedViewer.accessToken}`);
    expect(list1.body.broadcasts.some((b: { id: string }) => b.id === broadcastId)).toBe(false);

    const joinBlocked = await request(app)
      .post(`/live/broadcasts/${broadcastId}/join`)
      .set("Authorization", `Bearer ${unverifiedViewer.accessToken}`);
    expect(joinBlocked.status).toBe(403);
    expect(joinBlocked.body.error).toMatch(/age verification required/i);

    const verifiedViewer = await registerAndLogin(app, "user");
    await verifyAge(app, verifiedViewer.accessToken, verifiedViewer.user.id);

    const list2 = await request(app).get("/live/broadcasts").set("Authorization", `Bearer ${verifiedViewer.accessToken}`);
    expect(list2.body.broadcasts.some((b: { id: string }) => b.id === broadcastId)).toBe(true);

    const joinAllowed = await request(app)
      .post(`/live/broadcasts/${broadcastId}/join`)
      .set("Authorization", `Bearer ${verifiedViewer.accessToken}`);
    expect(joinAllowed.status).toBe(200);
    expect(joinAllowed.body.secureMode).toBe(true);

    // Restore the seeded default so this doesn't leak into other suites.
    await request(app)
      .post("/admin/config/adult-mode")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: false });
  });
});

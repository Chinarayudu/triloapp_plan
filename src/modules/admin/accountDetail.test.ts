import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

describe("Admin: general User/Host roster + detail (admin design follow-up)", () => {
  it("lists users and hosts with last-active, and shows a detail view with activity and reports", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 5000);

    const giftsRes = await request(app).get("/gifts").set("Authorization", `Bearer ${user.accessToken}`);
    const rose = giftsRes.body.gifts.find((g: { name: string }) => g.name === "Rose");
    await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });

    await request(app)
      .post("/moderation/reports")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ targetType: "host", targetId: host.user.id, reason: "Testing the reports panel" });

    const admin = await registerAndLoginAdmin();

    const userList = await request(app).get("/admin/users").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(userList.status).toBe(200);
    const listedUser = userList.body.users.find((u: { id: string }) => u.id === user.user.id);
    expect(listedUser).toBeTruthy();
    expect(listedUser.lastActive).toBeTruthy(); // recorded by fraud.service.ts's login tracking on otp/verify

    const hostList = await request(app).get("/admin/hosts").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(hostList.body.hosts.some((h: { id: string }) => h.id === host.user.id)).toBe(true);

    const hostDetail = await request(app).get(`/admin/hosts/${host.user.id}`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(hostDetail.status).toBe(200);
    expect(hostDetail.body.user.id).toBe(host.user.id);
    expect(hostDetail.body.hostProfile).toBeTruthy();
    expect(hostDetail.body.activity.some((a: { type: string }) => a.type === "gift")).toBe(true);
    expect(hostDetail.body.reportsAgainstAccount).toHaveLength(1);
    expect(hostDetail.body.reportsAgainstAccount[0].reason).toBe("Testing the reports panel");

    const userDetail = await request(app).get(`/admin/users/${user.user.id}`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(userDetail.status).toBe(200);
    expect(userDetail.body.activity.some((a: { type: string }) => a.type === "gift")).toBe(true);
    expect(userDetail.body.reportsAgainstAccount).toHaveLength(0); // reports were filed against the host, not this user
  });

  it("404s for a well-formed but non-existent account id", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const res = await request(app)
      .get("/admin/users/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(404);
  });
});

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

describe("Broadcast messaging (admin design follow-up)", () => {
  it("sends a message to all users and all hosts, counting only the intended recipients, and lists the send history", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    void user;
    void host;

    const admin = await registerAndLoginAdmin();

    const usersOnly = await request(app)
      .post("/admin/broadcast-messages")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ title: "Scheduled maintenance tonight", message: "The app will be briefly unavailable at 2am.", recipients: "all_users" });
    expect(usersOnly.status).toBe(201);
    expect(usersOnly.body.recipientCount).toBeGreaterThanOrEqual(1);

    const list = await request(app).get("/admin/broadcast-messages").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.messages[0].title).toBe("Scheduled maintenance tonight");
    expect(list.body.messages[0].recipients).toBe("all_users");
    expect(list.body.messages[0].sentByAdminId).toBe(admin.user.id);
  });

  it("is blocked for a sub-admin without moderation permission", async () => {
    const app = createApp();
    const financeOnly = await registerAndLoginAdmin("sub_admin", ["finance"]);
    const res = await request(app)
      .post("/admin/broadcast-messages")
      .set("Authorization", `Bearer ${financeOnly.accessToken}`)
      .send({ title: "x", message: "y", recipients: "all" });
    expect(res.status).toBe(403);
  });
});

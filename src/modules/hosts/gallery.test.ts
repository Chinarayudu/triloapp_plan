import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

describe("Host gallery (admin design follow-up)", () => {
  it("a host adds photo/video items, lists and deletes their own, and can't delete someone else's", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");

    const photo = await request(app)
      .post("/me/host-profile/gallery")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ mediaType: "photo", url: "https://example.com/photo.jpg" });
    expect(photo.status).toBe(201);
    expect(photo.body.mediaType).toBe("photo");

    const video = await request(app)
      .post("/me/host-profile/gallery")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ mediaType: "video", url: "https://example.com/video.mp4", durationSeconds: 24 });
    expect(video.status).toBe(201);
    expect(video.body.durationSeconds).toBe(24);

    const list = await request(app).get("/me/host-profile/gallery").set("Authorization", `Bearer ${host.accessToken}`);
    expect(list.body.items).toHaveLength(2);

    const otherHostDelete = await request(app)
      .delete(`/me/host-profile/gallery/${photo.body.id}`)
      .set("Authorization", `Bearer ${otherHost.accessToken}`);
    expect(otherHostDelete.status).toBe(404); // not theirs — doesn't exist from their point of view

    const ownDelete = await request(app)
      .delete(`/me/host-profile/gallery/${photo.body.id}`)
      .set("Authorization", `Bearer ${host.accessToken}`);
    expect(ownDelete.status).toBe(200);

    const listAfter = await request(app).get("/me/host-profile/gallery").set("Authorization", `Bearer ${host.accessToken}`);
    expect(listAfter.body.items).toHaveLength(1);
  });

  it("admin views and deletes any host's gallery item, logging the action", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const item = await request(app)
      .post("/me/host-profile/gallery")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ mediaType: "photo", url: "https://example.com/moderated.jpg" });

    const admin = await registerAndLoginAdmin();
    const adminList = await request(app)
      .get(`/admin/hosts/${host.user.id}/gallery`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.items.some((i: { id: string }) => i.id === item.body.id)).toBe(true);

    const adminDelete = await request(app)
      .delete(`/admin/hosts/${host.user.id}/gallery/${item.body.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminDelete.status).toBe(200);

    const listAfter = await request(app).get("/me/host-profile/gallery").set("Authorization", `Bearer ${host.accessToken}`);
    expect(listAfter.body.items).toHaveLength(0);

    const auditLog = await request(app).get("/admin/audit-log?limit=5").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(auditLog.body.entries[0].action).toBe("gallery.delete");
  });
});

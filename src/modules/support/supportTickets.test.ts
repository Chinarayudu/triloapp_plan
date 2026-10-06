import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("Support tickets: admin workflow", () => {
  it("links a ticket to the owner's call, filters and pages the admin list, and moves it through its statuses", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const otherAdmin = await registerAndLoginAdmin();
    const host = await registerAndLogin(app, "host");
    await request(app).patch("/host/me/presence").set(bearer(host.accessToken)).send({ isOnline: true });
    const user = await registerAndLogin(app, "user");
    const stranger = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10_000);
    const call = await request(app).post("/user/calls").set(bearer(user.accessToken)).send({ hostId: host.user.id });
    await request(app).post(`/user/calls/${call.body.callId}/end`).set(bearer(user.accessToken));

    const notTheirs = await request(app)
      .post("/user/me/support/tickets")
      .set(bearer(stranger.accessToken))
      .send({ subject: "Call", category: "billing", content: "Charged", refs: { callId: call.body.callId } });
    expect(notTheirs.status).toBe(400);

    const created = await request(app)
      .post("/user/me/support/tickets")
      .set(bearer(user.accessToken))
      .send({ subject: "Charged but the call dropped", category: "billing", content: "Please check", refs: { callId: call.body.callId } });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id as string;
    expect(created.body.ticket).toMatchObject({
      status: "open",
      priority: "medium",
      role: "user",
      requester: { id: user.user.id },
      refs: { callId: call.body.callId, withdrawalId: null },
      assigneeId: null,
    });
    expect(created.body.messages[0]).toMatchObject({ sender: "user", attachments: [] });

    const mine = await request(app).get("/user/me/support/tickets").set(bearer(user.accessToken));
    expect(mine.body).toMatchObject({ total: 1, tickets: [expect.objectContaining({ id: ticketId, refs: { callId: call.body.callId, withdrawalId: null } })] });

    const list = (query: string) => request(app).get(`/admin/support/tickets?${query}`).set(bearer(admin.accessToken));
    const byRole = await list(`role=user&category=billing&q=${encodeURIComponent("call dropped")}&pageSize=5`);
    expect(byRole.body).toMatchObject({ page: 1, pageSize: 5 });
    const row = byRole.body.tickets.find((t: { id: string }) => t.id === ticketId);
    // Flat fields for the Support screen, plus the original { ticket, account }.
    expect(row).toMatchObject({ id: ticketId, role: "user", requester: { id: user.user.id }, ticket: { id: ticketId }, account: { id: user.user.id } });
    expect((await list("role=host")).body.tickets.some((t: { id: string }) => t.id === ticketId)).toBe(false);
    expect((await list(`q=${ticketId}`)).body.tickets.map((t: { id: string }) => t.id)).toEqual([ticketId]);
    expect((await list("status=bogus")).status).toBe(400);

    const updated = await request(app)
      .patch(`/admin/support/tickets/${ticketId}`)
      .set(bearer(admin.accessToken))
      .send({ status: "waiting_on_customer", priority: "high", assigneeId: otherAdmin.user.id });
    expect(updated.body).toMatchObject({ status: "waiting_on_customer", priority: "high", assigneeId: otherAdmin.user.id });
    const notAnAdmin = await request(app).patch(`/admin/support/tickets/${ticketId}`).set(bearer(admin.accessToken)).send({ assigneeId: user.user.id });
    expect(notAnAdmin.status).toBe(400);

    // The customer replying puts it back in front of staff.
    await request(app).post(`/user/me/support/tickets/${ticketId}/messages`).set(bearer(user.accessToken)).send({ content: "Any update?" });
    expect((await request(app).get(`/admin/support/tickets/${ticketId}`).set(bearer(admin.accessToken))).body.ticket.status).toBe("open");

    // A ticket someone is working on stays in progress when the customer writes.
    await request(app).patch(`/admin/support/tickets/${ticketId}`).set(bearer(admin.accessToken)).send({ status: "in_progress" });
    await request(app).post(`/user/me/support/tickets/${ticketId}/messages`).set(bearer(user.accessToken)).send({ content: "Thanks" });
    expect((await request(app).get(`/admin/support/tickets/${ticketId}`).set(bearer(admin.accessToken))).body.ticket.status).toBe("in_progress");

    expect((await list("status=all")).status).toBe(200);
  });

  it("serves bot settings and help articles at the admin dashboard's paths too, including delete", async () => {
    const app = createApp();
    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);

    const settings = await request(app).get("/admin/support/bot-settings").set(bearer(moderator.accessToken));
    expect(settings.body).toMatchObject({ enabled: expect.any(Boolean), model: expect.any(String), maxRepliesPerTicket: expect.any(Number) });
    const original = { enabled: settings.body.enabled, model: settings.body.model, maxRepliesPerTicket: settings.body.maxRepliesPerTicket };
    try {
      const patched = await request(app).patch("/admin/support/bot-settings").set(bearer(moderator.accessToken)).send({ maxRepliesPerTicket: 3 });
      expect(patched.body).toMatchObject({ ...original, maxRepliesPerTicket: 3 });
      const viaConfig = await request(app).get("/admin/support/bot-config").set(bearer(moderator.accessToken));
      expect(viaConfig.body.current.maxRepliesPerTicket).toBe(3);
    } finally {
      await request(app).patch("/admin/support/bot-settings").set(bearer(moderator.accessToken)).send(original);
    }

    const created = await request(app)
      .post("/admin/support/articles")
      .set(bearer(moderator.accessToken))
      .send({ title: "Referrals", content: "Coming soon", audience: "all", active: true });
    expect(created.status).toBe(201);
    const listed = await request(app).get("/admin/support/kb").set(bearer(moderator.accessToken));
    expect(listed.body.articles.some((a: { id: string }) => a.id === created.body.id)).toBe(true);
    expect((await request(app).delete(`/admin/support/articles/${created.body.id}`).set(bearer(moderator.accessToken))).status).toBe(204);
    expect((await request(app).delete(`/admin/support/kb/${created.body.id}`).set(bearer(moderator.accessToken))).status).toBe(404);
  });
});

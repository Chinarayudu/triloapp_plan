import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, randomPhone, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";
import { getActiveSlabForBeans, getActiveWithdrawalPolicy } from "../withdrawals/withdrawal.service";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function signUpHostWithCode(app: ReturnType<typeof createApp>, referralCode: string) {
  const phone = randomPhone();
  const otp = await request(app).post("/host/auth/otp/request").send({ phone });
  return request(app).post("/host/auth/otp/verify").send({ phone, code: otp.body.devCode, role: "host", referralCode });
}

describe("Host profile & settings screens", () => {
  it("GET /me gives a host dateOfBirth, hostingId, a stable referralCode, stats and interests", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    await request(app).patch("/host/me").set(bearer(host.accessToken)).send({ dob: "2003-08-20" });

    const first = await request(app).get("/host/me").set(bearer(host.accessToken));
    expect(first.body.dateOfBirth).toBe("2003-08-20");
    expect(first.body.hostingId).toMatch(/^HST-\d+$/);
    expect(first.body.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(first.body.hostProfile.stats).toEqual({ followersCount: 0, talkTimeSeconds: 0, giftsReceivedCount: 0 });
    expect(first.body.hostProfile.interests).toEqual({ interests: [], hobbies: [], sports: [], film: [], music: [], traveling: [], food: [] });

    const again = await request(app).get("/host/me").set(bearer(host.accessToken));
    expect(again.body.referralCode).toBe(first.body.referralCode);
    expect(again.body.hostingId).toBe(first.body.hostingId);

    // Stats move with real activity: a follow and a gift.
    const user = await registerAndLogin(app, "user");
    await request(app).post(`/user/hosts/${host.user.id}/follow`).set(bearer(user.accessToken));
    const gifts = await request(app).get("/user/gifts").set(bearer(user.accessToken));
    await fundUserWallet(app, user.accessToken, gifts.body.gifts[0].pricePaise);
    await request(app).post("/user/gifts/send").set(bearer(user.accessToken)).send({ recipientId: host.user.id, giftId: gifts.body.gifts[0].id });
    const after = await request(app).get("/host/me").set(bearer(host.accessToken));
    expect(after.body.hostProfile.stats).toMatchObject({ followersCount: 1, giftsReceivedCount: 1 });

    const asUser = await request(app).get("/user/me").set(bearer(user.accessToken));
    expect(asUser.body.hostingId).toBeUndefined();
    expect(asUser.body.referralCode).toBeUndefined();
  });

  it("PATCH /me/host-profile saves the interests object; hobbies/sports also show on the Creator profile", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const saved = await request(app)
      .patch("/host/me/host-profile")
      .set(bearer(host.accessToken))
      .send({ interests: { interests: ["Pets"], hobbies: ["Cooking"], music: ["Lo-fi", "Bollywood"], food: [] } });
    expect(saved.status).toBe(200);

    const me = await request(app).get("/host/me").set(bearer(host.accessToken));
    expect(me.body.hostProfile.interests).toEqual({
      interests: ["Pets"],
      hobbies: ["Cooking"],
      sports: [],
      film: [],
      music: ["Lo-fi", "Bollywood"],
      traveling: [],
      food: [],
    });

    const user = await registerAndLogin(app, "user");
    const creator = await request(app).get(`/user/hosts/${host.user.id}`).set(bearer(user.accessToken));
    expect(creator.body.hobbies).toEqual(["Cooking"]);
  });

  it("a new host signing up with a referral code is listed under the referrer's streamers", async () => {
    const app = createApp();
    const referrer = await registerAndLogin(app, "host");
    const code = (await request(app).get("/host/me").set(bearer(referrer.accessToken))).body.referralCode;

    const joined = await signUpHostWithCode(app, code.toLowerCase()); // typed in lowercase still works
    expect(joined.status).toBe(200);
    expect(joined.body.referralApplied).toBe(true);

    const typo = await signUpHostWithCode(app, "NOTACODE");
    expect(typo.status).toBe(200); // a bad code never blocks signup
    expect(typo.body.referralApplied).toBe(false);

    const streamers = await request(app).get("/host/me/referrals?type=streamers").set(bearer(referrer.accessToken));
    expect(streamers.body.referrals).toHaveLength(1);
    expect(streamers.body.referrals[0]).toMatchObject({ id: joined.body.user.id, earnedForYouPaise: 0 });
    expect(streamers.body.referrals[0].joinedAt).toBeTruthy();
    const agents = await request(app).get("/host/me/referrals?type=agents").set(bearer(referrer.accessToken));
    expect(agents.body.referrals).toEqual([]);
  });

  it("GET /config's minWithdrawalBeans is the smallest amount the live policy accepts", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const config = await request(app).get("/host/config").set(bearer(host.accessToken));
    expect(config.body.invoiceCompany).toBeNull(); // INVOICE_COMPANY_* not set in tests

    const min = config.body.minWithdrawalBeans as number;
    const policy = await getActiveWithdrawalPolicy();
    const enough = async (beans: number) => beans * (await getActiveSlabForBeans(beans)).paisePerBean >= policy.minAmountPaise;
    expect(await enough(min)).toBe(true);
    if (min > 1) expect(await enough(min - 1)).toBe(false);
  });

  it("withdrawals and blocks are returned under both the old and the new keys", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    await request(app).patch("/user/me").set(bearer(user.accessToken)).send({ name: "Priya" });

    const withdrawals = await request(app).get("/host/withdrawals").set(bearer(host.accessToken));
    expect(withdrawals.body.withdrawals).toEqual([]);
    expect(withdrawals.body.requests).toEqual([]);

    await request(app).post("/host/moderation/blocks").set(bearer(host.accessToken)).send({ userId: user.user.id });
    const blocks = await request(app).get("/host/moderation/blocks").set(bearer(host.accessToken));
    expect(blocks.body.blocks).toEqual([{ user: { id: user.user.id, name: "Priya", avatarUrl: null }, blockedAt: expect.any(String) }]);
    expect(blocks.body.blocked[0]).toMatchObject({ id: user.user.id, name: "Priya" }); // User app's shape, unchanged
  });

  it("support chat: a host opens a ticket, an admin replies as agent and closes it, writing again reopens it", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");

    const created = await request(app)
      .post("/host/me/support/tickets")
      .set(bearer(host.accessToken))
      .send({ subject: "Payout delayed", category: "withdrawals", content: "My withdrawal is still processing" });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;
    expect(created.body.ticket.status).toBe("open");
    expect(created.body.messages).toEqual([
      expect.objectContaining({ sender: "host", content: "My withdrawal is still processing" }),
    ]);

    const list = await request(app).get("/host/me/support/tickets").set(bearer(host.accessToken));
    expect(list.body.tickets.map((t: { id: string }) => t.id)).toContain(ticketId);
    expect((await request(app).get(`/host/me/support/tickets/${ticketId}`).set(bearer(otherHost.accessToken))).status).toBe(404);
    expect((await request(app).get("/user/me/support/tickets").set(bearer(user.accessToken))).status).toBe(403);

    const admin = await registerAndLoginAdmin();
    const adminList = await request(app).get("/admin/support/tickets?status=open").set(bearer(admin.accessToken));
    expect(adminList.body.tickets.some((t: { ticket: { id: string } }) => t.ticket.id === ticketId)).toBe(true);

    const reply = await request(app)
      .post(`/admin/support/tickets/${ticketId}/messages`)
      .set(bearer(admin.accessToken))
      .send({ content: "Checking with the bank now" });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ sender: "agent", senderName: "Support team", content: "Checking with the bank now" });

    const closed = await request(app).patch(`/admin/support/tickets/${ticketId}`).set(bearer(admin.accessToken)).send({ status: "closed" });
    expect(closed.body.status).toBe("closed");

    const hostReply = await request(app)
      .post(`/host/me/support/tickets/${ticketId}/messages`)
      .set(bearer(host.accessToken))
      .send({ content: "Thanks!" });
    expect(hostReply.status).toBe(201);
    const thread = await request(app).get(`/host/me/support/tickets/${ticketId}`).set(bearer(host.accessToken));
    expect(thread.body.ticket.status).toBe("open");
    expect(thread.body.messages.map((m: { sender: string }) => m.sender)).toEqual(["host", "agent", "host"]);

    expect((await request(app).get("/admin/support/tickets").set(bearer(host.accessToken))).status).toBe(403);
  });
});

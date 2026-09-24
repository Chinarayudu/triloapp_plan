import { eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { chatMessages, hostProfiles, hostWallets, users } from "../../db/schema";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

describe("Host levels", () => {
  it("a new host starts at Level 1 with ₹20 voice / ₹30 video / ₹5 message, and sees the 20-level table", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");

    const res = await request(app).get("/host/me/level").set("Authorization", `Bearer ${host.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.level).toBe(1);
    expect(res.body.lifetimeEarnedBeans).toBe(0);
    expect(res.body.beansToNextLevel).toBe(100_000);
    expect(res.body.maxPrices).toEqual({ voiceRatePerMinutePaise: 2000, videoRatePerMinutePaise: 3000, messageRatePaise: 500 });
    expect(res.body.currentPrices).toEqual(res.body.maxPrices); // no rate set -> charges the level price
    expect(res.body.nextLevelMaxPrices).toEqual({ voiceRatePerMinutePaise: 4000, videoRatePerMinutePaise: 5000, messageRatePaise: 2500 });
    expect(res.body.levels).toHaveLength(20);
    expect(res.body.levels[19]).toEqual({
      level: 20,
      requiredLifetimeBeans: 1_900_000,
      voiceRatePerMinutePaise: 40_000,
      videoRatePerMinutePaise: 41_000,
      messageRatePaise: 38_500,
    });
  });

  it("rejects a host rate above the level maximum, accepts one below, and null resets to the level price", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");

    const tooHigh = await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ voiceRatePerMinutePaise: 2100 });
    expect(tooHigh.status).toBe(400);

    await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ voiceRatePerMinutePaise: 1500, messageRatePaise: 300 });
    let detail = await request(app).get(`/user/hosts/${host.user.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(detail.body.level).toBe(1);
    expect(detail.body.voiceRatePerMinutePaise).toBe(1500);
    expect(detail.body.ratePerMinutePaise).toBe(3000); // never set -> level price
    expect(detail.body.messageRatePaise).toBe(300);

    await request(app)
      .patch("/host/me/host-profile")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ voiceRatePerMinutePaise: null });
    detail = await request(app).get(`/user/hosts/${host.user.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(detail.body.voiceRatePerMinutePaise).toBe(2000);
  });

  it("clamps a rate set before levels existed down to the host's level maximum", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    await db.update(hostProfiles).set({ ratePerMinutePaise: 6000 }).where(eq(hostProfiles.userId, host.user.id));
    const name = `clamp-${host.user.id.slice(0, 8)}`; // the shared test DB holds many hosts — search to find this one
    await db.update(users).set({ name }).where(eq(users.id, host.user.id));

    const list = await request(app).get(`/user/hosts?q=${name}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(list.body.hosts).toHaveLength(1);
    expect(list.body.hosts[0].ratePerMinutePaise).toBe(3000);
    const detail = await request(app).get(`/user/hosts/${host.user.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(detail.body.ratePerMinutePaise).toBe(3000);
  });

  it("charges a user the host's message price, credits the host, keeps host replies free, and blocks an unfunded user", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);

    const sent = await request(app)
      .post("/user/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "hello" });
    expect(sent.status).toBe(201);
    expect(sent.body.chargedPaise).toBe(500);
    expect(sent.body.userBalanceAfterPaise).toBe(9500);

    // 20% seeded commission: 500 -> 100 commission, 400 net -> 400 beans (1 paise/bean)
    const hostWallet = await request(app).get("/host/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    expect(hostWallet.body.beanBalance).toBe(400);
    const level = await request(app).get("/host/me/level").set("Authorization", `Bearer ${host.accessToken}`);
    expect(level.body.lifetimeEarnedBeans).toBe(400);

    const reply = await request(app)
      .post("/host/chat/messages")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ recipientId: user.user.id, content: "hi!" });
    expect(reply.status).toBe(201);
    expect(reply.body.chargedPaise).toBe(0);
    const userWallet = await request(app).get("/user/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(userWallet.body.balancePaise).toBe(9500);

    const broke = await registerAndLogin(app, "user");
    const refused = await request(app)
      .post("/user/chat/messages")
      .set("Authorization", `Bearer ${broke.accessToken}`)
      .send({ recipientId: host.user.id, content: "no money" });
    expect(refused.status).toBe(402);
    const stored = await db.select().from(chatMessages).where(eq(chatMessages.senderId, broke.user.id));
    expect(stored).toHaveLength(0); // the message rolled back with the failed charge
  });

  it("levels a host up automatically once lifetime earnings cross 1,00,000 beans, raising their unset prices", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10000);
    await db.update(hostWallets).set({ lifetimeEarnedBeans: 99_900 }).where(eq(hostWallets.hostId, host.user.id));

    await request(app)
      .post("/user/chat/messages")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, content: "pushes you over" }); // +400 beans -> 100,300

    const level = await request(app).get("/host/me/level").set("Authorization", `Bearer ${host.accessToken}`);
    expect(level.body.level).toBe(2);
    expect(level.body.beansToNextLevel).toBe(99_700);
    expect(level.body.currentPrices).toEqual({ voiceRatePerMinutePaise: 4000, videoRatePerMinutePaise: 5000, messageRatePaise: 2500 });

    const detail = await request(app).get(`/user/hosts/${host.user.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(detail.body.level).toBe(2);
    expect(detail.body.messageRatePaise).toBe(2500);
  });
});

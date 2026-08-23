import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { fundUserWallet, registerAndLogin } from "../../test/helpers";

async function getSeededGift(app: ReturnType<typeof createApp>, accessToken: string, name: string) {
  const res = await request(app).get("/gifts").set("Authorization", `Bearer ${accessToken}`);
  const gift = res.body.gifts.find((g: { name: string }) => g.name === name);
  if (!gift) throw new Error(`Seeded gift "${name}" not found — did db:seed run?`);
  return gift;
}

describe("Gifts: catalog and sending", () => {
  it("lists the active gift catalog", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");
    const res = await request(app).get("/gifts").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.gifts.length).toBeGreaterThan(0);
    expect(res.body.gifts.every((g: { active: boolean }) => g.active)).toBe(true);
  });

  it("sends a gift and applies the exact same commission/beans math as call billing", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 5000);

    const rose = await getSeededGift(app, user.accessToken, "Rose"); // seeded at 1000 paise

    const send = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });
    expect(send.status).toBe(201);
    // 1000 paise, 20% seeded commission -> 200 commission, 800 net -> 800 beans (1:1)
    expect(send.body.beansCredited).toBe(800);

    const userWallet = await request(app).get("/wallet").set("Authorization", `Bearer ${user.accessToken}`);
    expect(userWallet.body.balancePaise).toBe(5000 - 1000);

    const hostWallet = await request(app).get("/wallet").set("Authorization", `Bearer ${host.accessToken}`);
    expect(hostWallet.body.beanBalance).toBe(800);
  });

  it("rejects a nonexistent gift", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    const host = await registerAndLogin(app, "host");
    await fundUserWallet(app, user.accessToken, 5000);

    const res = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("rejects sending a gift to another user", async () => {
    const app = createApp();
    const user1 = await registerAndLogin(app, "user");
    const user2 = await registerAndLogin(app, "user");
    await fundUserWallet(app, user1.accessToken, 5000);
    const rose = await getSeededGift(app, user1.accessToken, "Rose");

    const res = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ recipientId: user2.user.id, giftId: rose.id });
    expect(res.status).toBe(400);
  });

  it("rejects sending with insufficient balance", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user"); // unfunded
    const host = await registerAndLogin(app, "host");
    const rose = await getSeededGift(app, user.accessToken, "Rose");

    const res = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ recipientId: host.user.id, giftId: rose.id });
    expect(res.status).toBe(402);
  });

  it("rejects a host trying to send a gift", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const otherHost = await registerAndLogin(app, "host");
    const rose = await getSeededGift(app, host.accessToken, "Rose");

    const res = await request(app)
      .post("/gifts/send")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ recipientId: otherHost.user.id, giftId: rose.id });
    expect(res.status).toBe(403);
  });
});

describe("Gifts: gift requests", () => {
  it("lets a host request a gift from a user", async () => {
    const app = createApp();
    const host = await registerAndLogin(app, "host");
    const user = await registerAndLogin(app, "user");

    const res = await request(app)
      .post("/gifts/request")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ userId: user.user.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects a user trying to request a gift", async () => {
    const app = createApp();
    const user1 = await registerAndLogin(app, "user");
    const user2 = await registerAndLogin(app, "user");

    const res = await request(app)
      .post("/gifts/request")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ userId: user2.user.id });
    expect(res.status).toBe(403);
  });

  it("rejects requesting from a target that isn't an active user", async () => {
    const app = createApp();
    const host1 = await registerAndLogin(app, "host");
    const host2 = await registerAndLogin(app, "host");

    const res = await request(app)
      .post("/gifts/request")
      .set("Authorization", `Bearer ${host1.accessToken}`)
      .send({ userId: host2.user.id });
    expect(res.status).toBe(400);
  });
});

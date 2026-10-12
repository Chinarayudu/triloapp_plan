import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { db } from "../../db/client";
import { hostRewardConfigs, hostWallets, ledgerEntries, notifications } from "../../db/schema";
import { fundUserWallet, registerAndLogin, registerAndLoginAdmin } from "../../test/helpers";
import { reconcileHostWallets } from "../wallet/reconciliation.service";
import { periodContaining, settleRewardPeriod } from "./rewards.service";

type App = ReturnType<typeof createApp>;

// Real earnings: each paid message is 500 paise -> 400 beans to the host
// (seeded 20% commission, 1 paise/bean).
async function earnFromMessages(app: App, userToken: string, hostId: string, messages: number) {
  for (let i = 0; i < messages; i++) {
    const sent = await request(app).post("/user/chat/messages").set("Authorization", `Bearer ${userToken}`).send({ recipientId: hostId, content: `hi ${i}` });
    expect(sent.status).toBe(201);
  }
}

// The shared test DB holds every other test's host earnings for today, so the
// settlement tests rank inside a random hour in the past instead: these hosts'
// real ledger credits are moved there, and nothing else is in it. Balances
// still match the ledger — only the timestamps change.
function randomPastHour(): { start: Date; end: Date } {
  const start = new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 20 * 365 * 24) * 3_600_000);
  return { start, end: new Date(start.getTime() + 3_600_000) };
}

async function moveEarningsInto(hostIds: string[], at: Date) {
  await db
    .update(ledgerEntries)
    .set({ createdAt: at })
    .where(and(inArray(ledgerEntries.ownerId, hostIds), eq(ledgerEntries.walletType, "host"), eq(ledgerEntries.referenceType, "chat_message")));
}

describe("Host rewards", () => {
  it("pays each ranked host their tier exactly once, skipping hosts below the minimum", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 100_000);
    const first = await registerAndLogin(app, "host");
    const second = await registerAndLogin(app, "host");
    const belowMinimum = await registerAndLogin(app, "host");
    await earnFromMessages(app, user.accessToken, first.user.id, 3); // 1200 beans
    await earnFromMessages(app, user.accessToken, second.user.id, 2); // 800 beans
    await earnFromMessages(app, user.accessToken, belowMinimum.user.id, 1); // 400 beans

    const { start, end } = randomPastHour();
    const hostIds = [first.user.id, second.user.id, belowMinimum.user.id];
    await moveEarningsInto(hostIds, new Date(start.getTime() + 60_000));
    await db.insert(hostRewardConfigs).values({
      period: "daily",
      enabled: true,
      minQualifyingBeans: 500,
      tiers: [
        { rank: 1, rewardBeans: 10_000 },
        { rank: 2, rewardBeans: 5_000 },
        { rank: 3, rewardBeans: 1_000 },
      ],
      effectiveFrom: start,
    });
    const balancesBefore = await db.select().from(hostWallets).where(inArray(hostWallets.hostId, hostIds));

    const winners = await settleRewardPeriod("daily", start, end);
    expect(winners).toEqual([
      { hostId: first.user.id, rank: 1, rewardBeans: 10_000 },
      { hostId: second.user.id, rank: 2, rewardBeans: 5_000 },
    ]);
    expect(await settleRewardPeriod("daily", start, end)).toBeNull(); // already settled — nothing paid twice

    const balancesAfter = await db.select().from(hostWallets).where(inArray(hostWallets.hostId, hostIds));
    const before = (id: string) => balancesBefore.find((w) => w.hostId === id)!;
    const after = (id: string) => balancesAfter.find((w) => w.hostId === id)!;
    expect(after(first.user.id).beanBalance).toBe(before(first.user.id).beanBalance + 10_000);
    expect(after(second.user.id).beanBalance).toBe(before(second.user.id).beanBalance + 5_000);
    expect(after(belowMinimum.user.id).beanBalance).toBe(before(belowMinimum.user.id).beanBalance);
    // Rewards don't count toward host level.
    expect(after(first.user.id).lifetimeEarnedBeans).toBe(before(first.user.id).lifetimeEarnedBeans);

    const drift = await reconcileHostWallets();
    expect(drift.filter((d) => hostIds.includes(d.ownerId))).toEqual([]);

    const notified = await db.select().from(notifications).where(eq(notifications.userId, first.user.id));
    expect(notified.find((n) => n.type === "host_reward")?.body).toMatch(/#1 — 10000 beans/);

    const history = await request(app).get("/host/me/rewards/history").set("Authorization", `Bearer ${first.accessToken}`);
    expect(history.status).toBe(200);
    expect(history.body.payouts).toHaveLength(1);
    expect(history.body.payouts[0]).toMatchObject({ period: "daily", rank: 1, beansEarned: 1200, rewardBeans: 10_000 });
  });

  it("settles a period with rewards off without paying anyone", async () => {
    const app = createApp();
    const user = await registerAndLogin(app, "user");
    await fundUserWallet(app, user.accessToken, 10_000);
    const host = await registerAndLogin(app, "host");
    await earnFromMessages(app, user.accessToken, host.user.id, 1);
    const { start, end } = randomPastHour();
    await moveEarningsInto([host.user.id], new Date(start.getTime() + 60_000));
    await db.insert(hostRewardConfigs).values({ period: "weekly", enabled: false, minQualifyingBeans: 0, tiers: [{ rank: 1, rewardBeans: 1_000 }], effectiveFrom: start });

    expect(await settleRewardPeriod("weekly", start, end)).toEqual([]);
  });

  it("lets a finance admin set the reward table, and shows it to hosts with their standing", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const host = await registerAndLogin(app, "host");
    const tiers = [
      { rank: 1, rewardBeans: 1_500_000 },
      { rank: 2, rewardBeans: 750_000 },
    ];

    const forbidden = await request(app).post("/admin/host-rewards/weekly").set("Authorization", `Bearer ${moderator.accessToken}`).send({ enabled: true, minQualifyingBeans: 0, tiers });
    expect(forbidden.status).toBe(403);
    const gap = await request(app)
      .post("/admin/host-rewards/weekly")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: true, minQualifyingBeans: 0, tiers: [{ rank: 2, rewardBeans: 5 }] });
    expect(gap.status).toBe(422);

    const saved = await request(app)
      .post("/admin/host-rewards/weekly")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ enabled: true, minQualifyingBeans: 1_000, tiers, reason: "launch" });
    expect(saved.status).toBe(201);
    const current = await request(app).get("/admin/host-rewards").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(current.body.weekly).toMatchObject({ enabled: true, minQualifyingBeans: 1_000, tiers });

    const rewards = await request(app).get("/host/me/rewards").set("Authorization", `Bearer ${host.accessToken}`);
    expect(rewards.status).toBe(200);
    expect(rewards.body.weekly).toMatchObject({
      enabled: true,
      tiers,
      totalRewardBeans: 2_250_000,
      minQualifyingBeans: 1_000,
      myBeans: 0,
      myRank: null,
      myRewardBeans: 0,
      beansToQualify: 1_000,
    });

    const standings = await request(app).get("/admin/host-rewards/weekly/standings").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(standings.status).toBe(200);
    const settlements = await request(app).get("/admin/host-rewards/weekly/settlements").set("Authorization", `Bearer ${admin.accessToken}`);
    expect(settlements.status).toBe(200);

    // Leave weekly rewards off again for the rest of the suite.
    await request(app).post("/admin/host-rewards/weekly").set("Authorization", `Bearer ${admin.accessToken}`).send({ enabled: false, minQualifyingBeans: 0, tiers: [] });
  });

  it("uses India-time days and Monday-to-Monday weeks", () => {
    // Wednesday 14 Oct 2026, 10:00 IST
    const wednesday = new Date("2026-10-14T04:30:00Z");
    expect(periodContaining("weekly", wednesday)).toEqual({ start: new Date("2026-10-11T18:30:00Z"), end: new Date("2026-10-18T18:30:00Z") });
    expect(periodContaining("daily", wednesday)).toEqual({ start: new Date("2026-10-13T18:30:00Z"), end: new Date("2026-10-14T18:30:00Z") });
    // 00:30 IST on Monday 19 Oct is already the next week.
    expect(periodContaining("weekly", new Date("2026-10-18T19:00:00Z")).start).toEqual(new Date("2026-10-18T18:30:00Z"));
  });
});

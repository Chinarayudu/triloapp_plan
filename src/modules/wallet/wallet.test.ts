import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { registerAndLogin } from "../../test/helpers";

describe("Wallet (dev-credit escape hatch)", () => {
  it("starts a new user at zero balance", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");
    const res = await request(app).get("/wallet").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.balancePaise).toBe(0);
  });

  it("dev-credits a user wallet and reflects it in GET /wallet", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "user");

    const credit = await request(app)
      .post("/wallet/dev-credit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ amountPaise: 50000 });
    expect(credit.status).toBe(200);
    expect(credit.body.balancePaise).toBe(50000);

    const wallet = await request(app).get("/wallet").set("Authorization", `Bearer ${accessToken}`);
    expect(wallet.body.balancePaise).toBe(50000);
  });

  it("rejects dev-credit for a HOST account", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");
    const res = await request(app)
      .post("/wallet/dev-credit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ amountPaise: 1000 });
    expect(res.status).toBe(403);
  });

  it("a host's wallet endpoint reports bean balance, starting at zero", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app, "host");
    const res = await request(app).get("/wallet").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.beanBalance).toBe(0);
  });
});

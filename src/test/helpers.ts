import { Express } from "express";
import request from "supertest";
import { db } from "../db/client";
import { users } from "../db/schema";
import { issueTokenPair } from "../modules/auth/token.service";
import { AdminPermission } from "../modules/admin/permissions";

export function randomPhone(): string {
  // E.164 — required by the /auth/otp endpoints. NODE_ENV=test always
  // forces dev-mode OTP delivery (src/lib/otpSender.ts), so this never
  // actually reaches Twilio regardless of format realism.
  return "+919" + Math.floor(100000000 + Math.random() * 899999999).toString();
}

export async function registerAndLogin(app: Express, role: "user" | "host" = "user") {
  const phone = randomPhone();
  const requestRes = await request(app).post("/auth/otp/request").send({ phone });
  const verifyRes = await request(app)
    .post("/auth/otp/verify")
    .send({ phone, code: requestRes.body.devCode, role });

  return verifyRes.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; role: string; phone: string; kycStatus: string };
  };
}

export async function fundUserWallet(app: Express, accessToken: string, amountPaise: number): Promise<number> {
  const res = await request(app)
    .post("/wallet/dev-credit")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ amountPaise });
  return res.body.balancePaise as number;
}

// Admin/sub-admin accounts have no signup flow by design (db/seedAdmin.ts's
// comment explains why) — this inserts the row directly, the same shortcut
// a real deploy takes via `npm run db:seed-admin`, then issues tokens the
// same way auth.routes.ts's otp/verify does.
export async function registerAndLoginAdmin(
  role: "admin" | "sub_admin" = "admin",
  permissions: AdminPermission[] = [],
) {
  const phone = randomPhone();
  const [user] = await db.insert(users).values({ phone, role, permissions }).returning();
  const tokens = await issueTokenPair(user.id, role);
  return { ...tokens, user };
}

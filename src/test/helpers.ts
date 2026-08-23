import { Express } from "express";
import request from "supertest";

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

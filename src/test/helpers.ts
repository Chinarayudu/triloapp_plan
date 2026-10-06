import { vi } from "vitest";
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
  // Auth is namespaced by app (API-design follow-up) — /user/auth/... and
  // /host/auth/... are the same underlying OTP router mounted twice
  // (app.ts), so either prefix works for either role; using the one that
  // matches `role` keeps tests reading like a real client of that app.
  const prefix = role === "host" ? "/host" : "/user";
  const phone = randomPhone();
  const requestRes = await request(app).post(`${prefix}/auth/otp/request`).send({ phone });
  const verifyRes = await request(app)
    .post(`${prefix}/auth/otp/verify`)
    .send({ phone, code: requestRes.body.devCode, role });

  return verifyRes.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; role: string; phone: string; kycStatus: string };
  };
}

export async function fundUserWallet(app: Express, accessToken: string, amountPaise: number): Promise<number> {
  const res = await request(app)
    .post("/user/wallet/dev-credit")
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

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

// Stands in for the Agora / Cloudflare HTTP APIs: records each request and
// answers with whatever `respond` returns for it, so nothing leaves the
// machine. Undo with vi.unstubAllGlobals().
export function stubFetch(respond: (url: string, body: unknown) => unknown): FetchCall[] {
  const seen: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body });
    return new Response(JSON.stringify(respond(url, body) ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return seen;
}

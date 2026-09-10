import { randomInt } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { otpCodes } from "../../db/schema";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { sha256 } from "../../lib/hash";
import { sendOtp } from "../../lib/otpSender";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export async function requestOtp(phone: string): Promise<{ devCode?: string }> {
  const code = randomInt(100000, 999999).toString();

  // One active code per phone — a new request supersedes any prior one.
  await db.delete(otpCodes).where(eq(otpCodes.phone, phone));
  await db.insert(otpCodes).values({
    phone,
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  await sendOtp(phone, code);

  return env.NODE_ENV === "production" ? {} : { devCode: code };
}

export async function verifyOtp(phone: string, code: string): Promise<void> {
  // Dev-only bypass (env.ts's OTP_BYPASS_VERIFICATION) — while the frontend
  // apps have no real OTP/SMS delivery wired up, this lets any phone + any
  // 6-digit code succeed without ever calling /otp/request first. Explicitly
  // scoped to "development" only, same convention as OTP_REAL_SMS_IN_DEV in
  // otpSender.ts — never in production, and never in tests either (the test
  // suite asserts real wrong-code/attempts behavior, and .env's dev-only
  // settings are still loaded when NODE_ENV=test, so this can't just check
  // "not production").
  if (env.NODE_ENV === "development" && env.OTP_BYPASS_VERIFICATION) {
    return;
  }

  const [record] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!record) {
    throw new AppError(400, "No active OTP for this phone — request a new one");
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new AppError(429, "Too many incorrect attempts — request a new code");
  }

  if (record.codeHash !== sha256(code)) {
    await db.update(otpCodes).set({ attempts: record.attempts + 1 }).where(eq(otpCodes.id, record.id));
    throw new AppError(400, "Incorrect code");
  }

  await db.delete(otpCodes).where(eq(otpCodes.id, record.id));
}

import { Redis } from "ioredis";
import { afterAll, beforeEach } from "vitest";

// Redis mode only (npm run test:redis, see vitest.config.ts). In-memory rate
// limits start fresh with every test file's app; Redis ones are shared by the
// whole run, so the OTP-request limit (5 per 15 minutes per IP) would be spent
// after a handful of logins. Clearing the counts gives each test the same
// fresh budget it gets in memory.
//
// Its own connection from process.env, not lib/redis: importing that here
// would load config/env.ts before a test file's vi.hoisted() env overrides
// (e.g. payments.cashfree.test.ts's fake keys) had run.
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

beforeEach(async () => {
  if (!redis) return;
  const keys = await redis.keys("rate-limit:*");
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis?.quit();
});

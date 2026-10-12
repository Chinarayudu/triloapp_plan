import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { getRedis, redisEnabled } from "../lib/redis";

// Where a limiter keeps its counts. With Redis (lib/redis.ts) every instance
// shares them, so a limit holds platform-wide; without it they live in this
// process's memory (express-rate-limit's default store, single instance
// only). `name` keeps each limiter's counts apart — it must be unique.
export function rateLimitStore(name: string): Store | undefined {
  if (!redisEnabled()) return undefined;
  return new RedisStore({
    prefix: `rate-limit:${name}:`,
    sendCommand: (command: string, ...args: string[]) => getRedis().call(command, ...args) as Promise<RedisReply>,
  });
}

// Keyed by authenticated user id, not IP — an IP-keyed limit either
// unfairly throttles a shared network (campus/office NAT, mobile carrier
// CGNAT) or is trivially dodged by rotating IPs, and every route this is
// used on already runs after requireAuth. Falls back to IP only if
// somehow called before auth is applied — ipKeyGenerator normalizes an
// IPv6 address to its /64 prefix first, since express-rate-limit refuses
// to start with a raw req.ip fallback (an IPv6 client could otherwise get
// a fresh limit per address in its /64 block).
export function perUserRateLimit(name: string, windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? "unknown"),
    store: rateLimitStore(name),
  });
}

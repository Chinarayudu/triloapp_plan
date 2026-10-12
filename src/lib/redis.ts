import { Redis } from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

// Redis is optional. With REDIS_URL set, everything that has to be shared
// between server instances lives there: host presence, call timers (BullMQ),
// rate limits, Socket.IO fan-out and the support bot's per-ticket lock. Without
// it, all of that stays in this process's memory — correct only while the
// backend runs as exactly one instance.

let shared: Redis | null = null;

export function redisEnabled(): boolean {
  return Boolean(env.REDIS_URL);
}

// One shared connection for ordinary commands.
export function getRedis(): Redis {
  if (!shared) shared = newRedisConnection();
  return shared;
}

// A separate connection — BullMQ workers block on theirs and the Socket.IO
// adapter needs its own publisher and subscriber. BullMQ requires
// maxRetriesPerRequest: null.
export function newRedisConnection(): Redis {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is not set");
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("error", (err) => logger.error({ err }, "Redis connection error"));
  return connection;
}

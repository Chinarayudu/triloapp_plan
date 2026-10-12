import { getRedis, redisEnabled } from "../../lib/redis";

// Which hosts have toggled themselves online. With Redis (lib/redis.ts) it's a
// shared set every instance reads, and it survives restarts; without Redis
// it's this process's memory — correct only for a single instance.
// onlineSessions.service.ts is the only writer.

const ONLINE_HOSTS_KEY = "presence:online-hosts";
const onlineHostIds = new Set<string>();

export async function setOnline(hostId: string): Promise<void> {
  if (redisEnabled()) {
    await getRedis().sadd(ONLINE_HOSTS_KEY, hostId);
    return;
  }
  onlineHostIds.add(hostId);
}

export async function setOffline(hostId: string): Promise<void> {
  if (redisEnabled()) {
    await getRedis().srem(ONLINE_HOSTS_KEY, hostId);
    return;
  }
  onlineHostIds.delete(hostId);
}

export async function isOnline(hostId: string): Promise<boolean> {
  if (redisEnabled()) return (await getRedis().sismember(ONLINE_HOSTS_KEY, hostId)) === 1;
  return onlineHostIds.has(hostId);
}

export async function listOnlineHostIds(): Promise<string[]> {
  if (redisEnabled()) return getRedis().smembers(ONLINE_HOSTS_KEY);
  return Array.from(onlineHostIds);
}

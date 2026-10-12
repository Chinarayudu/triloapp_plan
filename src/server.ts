import { createServer } from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { pool } from "./db/client";
import { logger } from "./lib/logger";
import { reapStaleCalls, startCallReaper } from "./modules/calls/callReaper";
import { expireRinging, runBillingTick } from "./modules/calls/calls.service";
import { closeCallTimerQueue, startCallTimerWorker } from "./modules/calls/callTimers";
import { startOnlineSessionSweep, sweepOnlineSessions } from "./modules/hosts/onlineSessionSweep";
import { settleClosedRewardPeriods, startHostRewardSweep } from "./modules/hosts/rewards.service";
import { startReconciliationSweep } from "./modules/wallet/reconciliation.service";
import { createSocketServer } from "./realtime/socket";

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);
// Only with Redis (lib/redis.ts): runs the BullMQ billing-tick and
// ringing-timeout jobs. Without Redis those are in-process timers instead.
const callTimerWorker = startCallTimerWorker({ onTick: runBillingTick, onRingingTimeout: expireRinging });

httpServer.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT}`);
});

// Runs once immediately at boot (BACKEND_PLAN.md §8 "Mid-call failure") —
// without Redis, call-timer state (callTimers.ts) doesn't survive a restart, so
// any call left "ongoing"/"ringing" from before this boot needs closing out
// before it can ever get stuck. Then keeps sweeping on an interval as a
// defense-in-depth backstop for a timer that dies without a restart.
void reapStaleCalls().catch((err) => logger.error({ err }, "Startup call reaper sweep failed"));
startCallReaper(env.CALL_REAPER_INTERVAL_MS);
startReconciliationSweep(env.WALLET_RECONCILIATION_INTERVAL_MS);

// Same boot-then-interval shape as the call reaper: without Redis presence
// is in-memory, so online sessions left open by the previous process are
// closed at boot (with Redis presence survives, and the sweep leaves them).
void sweepOnlineSessions().catch((err) => logger.error({ err }, "Startup online session sweep failed"));
startOnlineSessionSweep(30_000);

// Pays out each daily/weekly host reward period once it has closed (hosts/
// rewards.service.ts). Every instance may run it; each period settles once.
void settleClosedRewardPeriods().catch((err) => logger.error({ err }, "Startup host reward sweep failed"));
startHostRewardSweep(10 * 60_000);

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  httpServer.close(async () => {
    // Lets a running billing tick finish before the connections it needs close.
    await callTimerWorker?.close();
    await closeCallTimerQueue();
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

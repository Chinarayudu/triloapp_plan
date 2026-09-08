import { createServer } from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { pool } from "./db/client";
import { logger } from "./lib/logger";
import { reapStaleCalls, startCallReaper } from "./modules/calls/callReaper";
import { startReconciliationSweep } from "./modules/wallet/reconciliation.service";
import { createSocketServer } from "./realtime/socket";

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT}`);
});

// Runs once immediately at boot (BACKEND_PLAN.md §8 "Mid-call failure") —
// in-memory call-timer state (callTimers.ts) doesn't survive a restart, so
// any call left "ongoing"/"ringing" from before this boot needs closing out
// before it can ever get stuck. Then keeps sweeping on an interval as a
// defense-in-depth backstop for a timer that dies without a restart.
void reapStaleCalls().catch((err) => logger.error({ err }, "Startup call reaper sweep failed"));
startCallReaper(env.CALL_REAPER_INTERVAL_MS);
startReconciliationSweep(env.WALLET_RECONCILIATION_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  httpServer.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

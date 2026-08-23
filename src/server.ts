import { createServer } from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { pool } from "./db/client";
import { logger } from "./lib/logger";
import { createSocketServer } from "./realtime/socket";

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  httpServer.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

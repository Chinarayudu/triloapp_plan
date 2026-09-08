import cors from "cors";
import express, { Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { adminRouter } from "./modules/admin/admin.routes";
import { createAuthRouter } from "./modules/auth/auth.routes";
import { callsRouter } from "./modules/calls/calls.routes";
import { chatRouter } from "./modules/chat/chat.routes";
import { giftsRouter } from "./modules/gifts/gifts.routes";
import { hostsRouter } from "./modules/hosts/hosts.routes";
import { liveRouter } from "./modules/live/live.routes";
import { moderationRouter } from "./modules/moderation/moderation.routes";
import { usersRouter } from "./modules/users/users.routes";
import { walletRouter } from "./modules/wallet/wallet.routes";
import { withdrawalsRouter } from "./modules/withdrawals/withdrawal.routes";
import { healthRouter } from "./routes/health";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.use("/health", healthRouter);
  app.use("/auth", createAuthRouter());
  app.use(usersRouter);
  app.use(hostsRouter);
  app.use(walletRouter);
  app.use(callsRouter);
  app.use(chatRouter);
  app.use(giftsRouter);
  app.use(liveRouter);
  app.use(withdrawalsRouter);
  app.use(moderationRouter);
  app.use(adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

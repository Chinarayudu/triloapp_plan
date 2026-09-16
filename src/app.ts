import cors from "cors";
import express, { Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { adminRouter } from "./modules/admin/admin.routes";
import { createAdminAuthRouter, createOtpAuthRouter, createSessionRouter } from "./modules/auth/auth.routes";
import { callsRouter } from "./modules/calls/calls.routes";
import { chatRouter } from "./modules/chat/chat.routes";
import { giftsRouter } from "./modules/gifts/gifts.routes";
import { hostsRouter } from "./modules/hosts/hosts.routes";
import { liveRouter } from "./modules/live/live.routes";
import { moderationRouter } from "./modules/moderation/moderation.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { usersRouter } from "./modules/users/users.routes";
import { earningsRouter } from "./modules/wallet/earnings.routes";
import { vipRouter } from "./modules/wallet/vip.routes";
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
  app.use("/admin/auth", createAdminAuthRouter()); // /admin/auth/login

  // Session lifecycle (refresh/logout) doesn't vary by role — mounted at all
  // three prefixes from one shared instance so every app's token still works
  // post-split without duplicating the rotate/revoke logic three times.
  const sessionRouter = createSessionRouter();
  for (const prefix of ["/user/auth", "/host/auth", "/admin/auth"]) app.use(prefix, sessionRouter);

  // Every User/Host-facing router below is mounted twice, once under /user
  // and once under /host, at the *same* router instance both times (not a
  // fresh one per mount) — the routes inside already gate who can actually
  // succeed via requireRole/ownership checks (e.g. POST /calls/:id/accept
  // still 403s a user regardless of which prefix they hit it through), so
  // this changes no behavior. What it buys: a request or error in the logs
  // is now attributable to which app made it by URL alone (API-design
  // follow-up) — previously User and Host called the exact same paths and
  // an issue with, say, /calls couldn't be pinned to one app without also
  // checking the caller's JWT role.
  const otpAuthRouter = createOtpAuthRouter();
  const perAppRouters = [
    usersRouter,
    hostsRouter,
    walletRouter,
    vipRouter,
    earningsRouter,
    callsRouter,
    chatRouter,
    giftsRouter,
    liveRouter,
    withdrawalsRouter,
    moderationRouter,
    notificationsRouter,
  ];
  for (const prefix of ["/user", "/host"]) {
    app.use(`${prefix}/auth`, otpAuthRouter);
    for (const router of perAppRouters) app.use(prefix, router);
  }

  app.use(adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

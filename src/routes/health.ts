import { Router } from "express";
import { checkDbConnection } from "../db/client";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const dbOk = await checkDbConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "ok" : "unreachable",
  });
});

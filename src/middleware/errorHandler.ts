import { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

// Express identifies error middleware by its 4-argument signature —
// `next` must stay in the signature even though it's unused here.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error({ err, path: req.path }, "Unhandled request error");
  res.status(500).json({ error: "Internal server error" });
}

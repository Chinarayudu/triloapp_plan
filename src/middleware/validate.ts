import { NextFunction, Request, Response } from "express";
import { ZodType } from "zod";
import { AppError } from "../lib/errors";

export function validateBody(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, result.error.issues.map((i) => i.message).join(", ")));
      return;
    }
    req.body = result.data;
    next();
  };
}

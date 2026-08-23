import { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import { AccessTokenPayload, verifyAccessToken } from "../lib/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new AppError(401, "Missing or malformed Authorization header"));
    return;
  }

  try {
    req.user = verifyAccessToken(header.slice("Bearer ".length));
    next();
  } catch {
    next(new AppError(401, "Invalid or expired access token"));
  }
}

export function requireRole(...roles: AccessTokenPayload["role"][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new AppError(403, "Not allowed for this role"));
      return;
    }
    next();
  };
}

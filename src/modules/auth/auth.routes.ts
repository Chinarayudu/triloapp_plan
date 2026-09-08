import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { logger } from "../../lib/logger";
import { verifyPassword } from "../../lib/password";
import { recordLoginAndCheckMultiAccounting } from "../moderation/fraud.service";
import { createUser, findUserByEmail, findUserByPhone } from "../users/users.service";
import { requestOtp, verifyOtp } from "./otp.service";
import { issueTokenPair, revokeRefreshToken, rotateRefreshToken } from "./token.service";

// E.164 (+countrycode + number, e.g. +919876543210) — required now that OTP
// delivery can go through real Twilio SMS, which needs a real, unambiguous
// destination number, not a bare local number.
const e164Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone must be in E.164 format, e.g. +919876543210");

const phoneSchema = z.object({ phone: e164Phone });
const verifySchema = z.object({
  phone: e164Phone,
  code: z.string().length(6),
  role: z.enum(["user", "host"]).default("user"),
  // Client-generated, opt-in (BACKEND_PLAN.md §8 "Fraud", Phase 11) — used
  // only to correlate accounts sharing one device (fraud.service.ts's
  // multi-accounting check). Absent for clients that don't send one yet.
  deviceFingerprint: z.string().min(1).max(200).optional(),
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const adminLoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// A factory, not a module-level router: express-rate-limit's store is
// created fresh per call, so each createApp() gets its own isolated
// rate-limit counter instead of sharing one across every app instance
// a process creates (which is exactly what test isolation needs).
export function createAuthRouter(): Router {
  const authRouter = Router();
  const otpRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
  // Separate budget from OTP requests, and generous-but-bounded against
  // password-guessing (BACKEND_PLAN.md §8 "Rate limiting") — keyed by IP
  // since there's no authenticated identity yet at this point.
  const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

  authRouter.post("/otp/request", otpRequestLimiter, validateBody(phoneSchema), async (req, res, next) => {
    try {
      const { phone } = req.body as z.infer<typeof phoneSchema>;
      const result = await requestOtp(phone);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  authRouter.post("/otp/verify", validateBody(verifySchema), async (req, res, next) => {
    try {
      const { phone, code, role, deviceFingerprint } = req.body as z.infer<typeof verifySchema>;
      await verifyOtp(phone, code);

      // role is only honored for brand-new signups — an existing account
      // keeps whatever role it already has, so this can't be used to
      // escalate an existing user into a host (or vice versa).
      let user = await findUserByPhone(phone);
      if (!user) {
        user = await createUser(phone, role);
      }

      if (user.status !== "active") {
        throw new AppError(403, "Account is suspended");
      }

      // Awaited (not fire-and-forget) so the result is deterministic for
      // callers/tests, but never lets a fraud-check hiccup fail a
      // legitimate login — this is a background signal, not a gate.
      try {
        await recordLoginAndCheckMultiAccounting(user.id, deviceFingerprint);
      } catch (err) {
        logger.error({ err }, "Multi-accounting check failed");
      }

      const tokens = await issueTokenPair(user.id, user.role);
      res.json({
        ...tokens,
        user: { id: user.id, role: user.role, phone: user.phone, kycStatus: user.kycStatus },
      });
    } catch (err) {
      next(err);
    }
  });

  // Admin/sub-admin only (Phase 9 follow-up, matching the admin web app's
  // design) — Users/Hosts never hit this, they only ever use OTP above.
  // Deliberately does not distinguish "no such email" from "wrong
  // password" in its error (same generic message either way) so this
  // can't be used to enumerate which admin emails exist.
  authRouter.post("/admin/login", adminLoginLimiter, validateBody(adminLoginSchema), async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof adminLoginSchema>;
      const user = await findUserByEmail(email);
      const genericError = () => new AppError(401, "Invalid email or password");

      if (!user || (user.role !== "admin" && user.role !== "sub_admin") || !user.passwordHash) {
        throw genericError();
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        throw genericError();
      }
      if (user.status !== "active") {
        throw new AppError(403, "Account is suspended");
      }

      const tokens = await issueTokenPair(user.id, user.role);
      res.json({
        ...tokens,
        user: { id: user.id, role: user.role, email: user.email, permissions: user.permissions },
      });
    } catch (err) {
      next(err);
    }
  });

  authRouter.post("/token/refresh", validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const tokens = await rotateRefreshToken(refreshToken);
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  authRouter.post("/logout", requireAuth, validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      await revokeRefreshToken(refreshToken, req.user!.sub);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return authRouter;
}

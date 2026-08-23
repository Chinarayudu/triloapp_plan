import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { createUser, findUserByPhone } from "../users/users.service";
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
});
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

// A factory, not a module-level router: express-rate-limit's store is
// created fresh per call, so each createApp() gets its own isolated
// rate-limit counter instead of sharing one across every app instance
// a process creates (which is exactly what test isolation needs).
export function createAuthRouter(): Router {
  const authRouter = Router();
  const otpRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

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
      const { phone, code, role } = req.body as z.infer<typeof verifySchema>;
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

      const tokens = await issueTokenPair(user.id, user.role);
      res.json({
        ...tokens,
        user: { id: user.id, role: user.role, phone: user.phone, kycStatus: user.kycStatus },
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

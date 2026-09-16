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

// A factory, not a module-level router: express-rate-limit's store is
// created fresh per call, so each createApp() gets its own isolated
// rate-limit counter instead of sharing one across every app instance
// a process creates (which is exactly what test isolation needs).
//
// Mounted under both /user/auth and /host/auth (app.ts) — call this once per
// createApp() and mount the single returned instance at both paths, not once
// per mount point, so the OTP-request rate-limit budget is shared across
// both app surfaces rather than doubled (API-design follow-up: User and Host
// now hit different URLs for the same login/signup flow, purely so a
// request/error in the logs is attributable to which app made it — the
// underlying OTP logic is identical and unduplicated). Not mounted for
// admin — admin/sub-admin has no OTP signup path at all, only
// createAdminAuthRouter's email+password login below.
export function createOtpAuthRouter(): Router {
  const router = Router();
  const otpRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

  router.post("/otp/request", otpRequestLimiter, validateBody(phoneSchema), async (req, res, next) => {
    try {
      const { phone } = req.body as z.infer<typeof phoneSchema>;
      const result = await requestOtp(phone);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/otp/verify", validateBody(verifySchema), async (req, res, next) => {
    try {
      const { phone, code, role, deviceFingerprint } = req.body as z.infer<typeof verifySchema>;
      await verifyOtp(phone, code);

      // Looked up strictly by (phone, role) — this phone number may
      // separately have a "user" account, a "host" account, or both
      // (users table is unique per phone+role, not phone alone), each a
      // fully independent identity/wallet. Verifying via /user/auth/...
      // with role "user" only ever finds-or-creates that phone's USER
      // account; it can never return or escalate into its HOST account
      // (or vice versa via /host/auth/...) — they're different rows.
      let user = await findUserByPhone(phone, role);
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

  return router;
}

// Token refresh/logout genuinely don't vary by role at all (same rotate/
// revoke-by-caller-id logic for a user, host, admin, or sub-admin token
// alike) — kept as their own router, separate from the OTP signup/login
// router above, and mounted at all three prefixes (/user/auth, /host/auth,
// /admin/auth) in app.ts so every role keeps a working session lifecycle
// post-split, without also exposing OTP signup under the admin prefix.
export function createSessionRouter(): Router {
  const router = Router();

  router.post("/token/refresh", validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const tokens = await rotateRefreshToken(refreshToken);
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", requireAuth, validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      await revokeRefreshToken(refreshToken, req.user!.sub);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const adminLoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// Separate from the OTP router above (not just a different path on the same
// one): admin/sub-admin login is email+password, not phone/OTP — the admin
// web app's own login screen. Mounted at /admin/auth (app.ts) alongside
// createSessionRouter's token/refresh + logout, so admin's whole auth
// surface lives under one consistent /admin/auth/* prefix, the same pattern
// /user/auth/* and /host/auth/* follow.
export function createAdminAuthRouter(): Router {
  const router = Router();
  // Separate budget from OTP requests, and generous-but-bounded against
  // password-guessing (BACKEND_PLAN.md §8 "Rate limiting") — keyed by IP
  // since there's no authenticated identity yet at this point.
  const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

  // Deliberately does not distinguish "no such email" from "wrong password"
  // in its error (same generic message either way) so this can't be used to
  // enumerate which admin emails exist.
  router.post("/login", adminLoginLimiter, validateBody(adminLoginSchema), async (req, res, next) => {
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

  return router;
}

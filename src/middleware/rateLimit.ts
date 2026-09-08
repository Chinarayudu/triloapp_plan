import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Keyed by authenticated user id, not IP — an IP-keyed limit either
// unfairly throttles a shared network (campus/office NAT, mobile carrier
// CGNAT) or is trivially dodged by rotating IPs, and every route this is
// used on already runs after requireAuth. Falls back to IP only if
// somehow called before auth is applied — ipKeyGenerator normalizes an
// IPv6 address to its /64 prefix first, since express-rate-limit refuses
// to start with a raw req.ip fallback (an IPv6 client could otherwise get
// a fresh limit per address in its /64 block).
//
// In-memory store — same single-instance tradeoff as presence.store.ts
// and callTimers.ts; needs a shared store (e.g. Redis) once there's more
// than one API instance, so the limit is enforced per-process rather than
// per-account platform-wide.
export function perUserRateLimit(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? "unknown"),
  });
}

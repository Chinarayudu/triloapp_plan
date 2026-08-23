import { createHash } from "node:crypto";

// SHA-256 is enough here: both OTP codes and refresh tokens are short-lived,
// high-entropy-or-attempt-limited values, not user-chosen passwords — no
// need for a slow password hash (argon2/bcrypt) on either.
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

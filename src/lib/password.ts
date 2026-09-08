import bcrypt from "bcryptjs";

// Admin/sub-admin login only (Phase 9 follow-up) — Users/Hosts never touch
// this, they authenticate via phone/OTP only (BR-ACC-02).
const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

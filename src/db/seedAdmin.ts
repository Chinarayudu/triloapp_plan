import { db, pool } from "./client";
import { users } from "./schema";
import { hashPassword } from "../lib/password";
import { findUserByEmail, findUserByPhone } from "../modules/users/users.service";

// Provisions the first ADMIN account out-of-band (BR-ACC-01) — there is no
// signup flow for role=admin/sub_admin (auth.routes.ts only ever creates
// USER/HOST rows), by design: an admin account isn't something anyone
// should be able to self-register. Run once per environment:
//   npm run db:seed-admin -- +919876543210 admin@company.com "a-strong-password"
// The account then authenticates via POST /auth/admin/login (email +
// password, Phase 9 follow-up matching the admin web app's design) — this
// script only creates the row. Phone is still required (users.phone is a
// required unique column shared by every role) but isn't how this account
// signs in.
async function seedAdmin(): Promise<void> {
  const [phone, email, password] = process.argv.slice(2);
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone) || !email || !password || password.length < 8) {
    console.error(
      'Usage: npm run db:seed-admin -- +919876543210 admin@company.com "a-strong-password" (phone E.164, password 8+ chars)',
    );
    process.exit(1);
  }

  const existingByPhone = await findUserByPhone(phone);
  const existingByEmail = await findUserByEmail(email);
  if (existingByPhone || existingByEmail) {
    const existing = existingByPhone ?? existingByEmail!;
    console.log(`${existing.phone} / ${existing.email} is already registered as role=${existing.role} — nothing to do`);
  } else {
    const passwordHash = await hashPassword(password);
    const [admin] = await db.insert(users).values({ phone, email, role: "admin", passwordHash }).returning();
    console.log(`Created admin account ${admin.id} for ${email}`);
  }

  await pool.end();
}

seedAdmin().catch((err) => {
  console.error("Admin seed failed:", err);
  process.exit(1);
});

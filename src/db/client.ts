import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import * as schema from "./schema";

// Neon requires SSL; explicit here rather than relying on sslmode parsing
// from the connection string, since that's implicit and easy to break silently.
// The one exception is a local Postgres (Docker, for local dev/tests) — it
// doesn't speak SSL at all, and DATABASE_URL only ever points at localhost
// in that case, never in a real deploy, so this can't accidentally weaken
// the production/staging connection.
const isLocalDatabase = /^(localhost|127\.0\.0\.1)$/.test(new URL(env.DATABASE_URL).hostname);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: true },
});

export const db = drizzle(pool, { schema });

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    logger.error({ err }, "Database connectivity check failed");
    return false;
  }
}

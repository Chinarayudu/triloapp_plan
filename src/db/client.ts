import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import * as schema from "./schema";

// Neon requires SSL; explicit here rather than relying on sslmode parsing
// from the connection string, since that's implicit and easy to break silently.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
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

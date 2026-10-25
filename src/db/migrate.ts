import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

// Production migration runner. The prod Docker image installs runtime
// dependencies only, so drizzle-kit (a dev dependency, used by `npm run
// db:migrate`) isn't there. drizzle-kit's own migrate uses this same migrator
// and the same drizzle.__drizzle_migrations table, so either one can apply
// the next migration.
async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations applied");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("Migration failed", err);
    await pool.end();
    process.exit(1);
  });

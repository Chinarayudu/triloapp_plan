import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Using the pooled Neon connection string for now (it's the only one we
// have — see BUG_HISTORY.md workflow if migrations ever start behaving
// oddly under the pooler). Switch to a direct connection string for
// migrations once one is available (tech-stack/TECH_STACK.md §2).
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

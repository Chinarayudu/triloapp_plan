import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests hit a real Postgres — the dedicated test DATABASE_URL set
    // below, not a mock (tech-stack/TECH_STACK.md §9) — and each test file
    // opens its own connection pool; the default 5s timeout is tuned for
    // local/mocked tests, not real round-trips against an actual database.
    testTimeout: 40000,
    hookTimeout: 40000,
    env: {
      // A dedicated database, isolated from local dev and the shared
      // deployed backend (TECH_STACK.md §9: "a dedicated Neon branch as
      // the test database so tests run against real Postgres semantics,
      // not a mock" — local Postgres here instead of a Neon branch, same
      // isolation requirement). Tests write real rows (users, KYC
      // submissions, gifts, wallets...) — running them against the
      // shared DATABASE_URL from .env previously meant every test run
      // left fixture data in the same database the deployed admin/host
      // apps read from. Overridden here, not in .env, so `npm run dev`
      // and `npm test` never accidentally point at each other's database.
      // Set up locally via: docker run -d --name triloplan-test-db -p
      // 5433:5432 -e POSTGRES_USER=triloplan_test -e
      // POSTGRES_PASSWORD=triloplan_test -e POSTGRES_DB=triloplan_test
      // postgres:16-alpine — then `npm run db:migrate:test` once. CI
      // (.github/workflows/ci.yml) sets its own DATABASE_URL, pointing at
      // its ephemeral Postgres service container instead — the `??`
      // leaves that untouched rather than clobbering it with the local
      // port, since vitest.config.ts's `env` values would otherwise take
      // priority over what the CI step's `env:` block already set.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://triloplan_test:triloplan_test@localhost:5433/triloplan_test",
      // Disables real background call scheduling during tests — call
      // tests drive ticks deterministically via direct calls to
      // runBillingTick/expireRinging (calls.service.ts) instead of
      // waiting on (or racing) real timers. Values here just need to
      // outlast any single test file's real duration. Note this does NOT
      // touch calls.service.ts's TICK_INTERVAL_MS (fixed at 10s) — that's
      // the per-tick billing amount, a business constant, not a knob.
      CALL_SCHEDULER_INTERVAL_MS: "600000",
      CALL_RINGING_TIMEOUT_MS: "600000",
      // Same reasoning — the reaper/reconciliation sweeps aren't started by
      // any test (server.ts's setup, not app.ts's), but keep these out to
      // effectively-never anyway in case that ever changes.
      CALL_REAPER_INTERVAL_MS: "600000",
      WALLET_RECONCILIATION_INTERVAL_MS: "600000",
      // Socket tests (calls.socket.test.ts, presence.socket.test.ts, etc.)
      // call createSocketServer directly and do disconnect real sockets in
      // cleanup — same "drive it deterministically instead of waiting on
      // (or leaving dangling) a real timer" reasoning as the four above.
      // Tests exercise the grace-period check itself by calling
      // checkAbandonedBroadcast (realtime/socket.ts) directly.
      LIVE_BROADCAST_DISCONNECT_GRACE_MS: "600000",
    },
  },
});

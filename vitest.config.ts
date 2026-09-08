import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests hit the real Neon DB (tech-stack/TECH_STACK.md §9 — no mocking
    // Postgres), and each test file opens its own connection pool; the
    // default 5s timeout is tuned for local/mocked tests, not real network
    // round-trips to a remote pooled endpoint.
    testTimeout: 40000,
    hookTimeout: 40000,
    env: {
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
    },
  },
});

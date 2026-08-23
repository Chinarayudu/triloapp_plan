# Tech Stack — Node.js / Express / Postgres (Neon)

Confirmed: **Node.js + Express**, **PostgreSQL via Neon**. This document fills in everything around that choice. Companion to [`../BACKEND_PLAN.md`](../BACKEND_PLAN.md), which covers the domain design (wallet/ledger, calls, live, moderation) — this is purely "what packages/services do we build it with."

---

## 1. Runtime & language

- **Node.js** — current LTS (22.x at time of writing).
- **TypeScript**, not plain JS. Non-negotiable for this project specifically: the wallet/ledger/billing code moves real money, and compile-time typing on amounts, DTOs, and enum states (`CallStatus`, `WithdrawalStatus`, `LedgerReferenceType`) catches a whole class of bugs before they hit production. Use `tsx` for dev (fast, no separate compile step) and `tsc` for the production build.
- **Express 5** as the HTTP framework — it's what you asked for, and it's a fine choice here: this app is mostly REST + one WebSocket layer, not something that needs Nest's heavier DI/module system to stay organized. Structure it yourself with a clear folder-per-domain layout (`wallet/`, `calls/`, `live/`, `chat/`, `admin/`, `auth/`) so it doesn't turn into a flat pile of routes as it grows.

---

## 2. Database — Postgres on Neon

Postgres is the right call for this domain (relational integrity for the ledger/wallet system is not optional). Neon-specific notes, since serverless Postgres has a few sharp edges that matter for a billing-heavy app:

- **Two connection strings, use both**: Neon gives you a **pooled** (PgBouncer-compatible, transaction mode) connection string and a **direct** one.
  - App runtime (Express handlers, the billing-tick job, webhook handlers) → **pooled** connection. You'll have many short-lived queries firing concurrently (billing ticks, socket-triggered writes); without pooling you'll hit Neon's direct connection limit fast.
  - Migrations / schema changes / anything needing a session-level feature (advisory locks held across statements) → **direct** connection.
- **Autosuspend / cold start**: Neon suspends compute after inactivity on lower tiers, and the next query pays a cold-start cost (hundreds of ms to a couple seconds). Fine for dev/staging branches; for **production, use a plan/setting that keeps compute warm** (disable autosuspend or keep min compute > 0) — a billing tick or an in-progress call is not where you want a surprise cold-start delay.
- **Branching**: this is Neon's actual advantage over plain managed Postgres — create a full DB branch per PR/feature for testing migrations against prod-like data without touching prod. Use it for the wallet/ledger migrations especially, since those are the ones you least want to get wrong.
- **Read replicas**: push admin-dashboard/analytics queries to a Neon read replica so heavy reporting queries never compete with the hot path (billing ticks, call writes).
- **Backups/PITR**: Neon supports point-in-time restore — confirm the retention window covers your compliance needs before launch; a money app needs this story settled, not assumed.

---

## 3. Data access layer

- **Drizzle ORM** (recommended) over Prisma for this specific project: it stays close to SQL (matters when you need explicit `SELECT ... FOR UPDATE` row locks for wallet debits/credits), has first-class Postgres support, and its migration story works cleanly with Neon's branching model. Prisma is a fine alternative if the team is more comfortable with it — the main requirement is: whichever ORM, the **wallet/ledger transaction code should use raw parameterized SQL or the ORM's raw/transaction escape hatch**, not high-level ORM sugar, so the locking and atomicity are explicit and auditable.
- **node-postgres (`pg`)** underneath either ORM choice, pointed at the pooled connection string.
- Migrations: Drizzle Kit (or Prisma Migrate) — run against a Neon branch in CI before merging, then apply to prod branch on deploy.

---

## 4. Cache, locks, presence

- **Redis** — required for: wallet-mutation locks during billing ticks, host online/offline presence, rate limiting, Socket.io's cross-instance adapter, BullMQ's queue backend.
- **Upstash Redis** pairs naturally with the serverless-leaning Neon setup (usage-based, no server to manage) if you want to stay in that operational model. A standard managed Redis (AWS ElastiCache, Redis Cloud) works equally well if you'd rather have a persistent instance with lower per-op latency for the lock-heavy billing path — worth benchmarking both under real billing-tick load before committing, since lock latency directly affects call-billing throughput.
- Client: `ioredis`.

---

## 5. Background jobs / scheduling

- **BullMQ** (Redis-backed queues) for: the per-call billing tick scheduler, payment webhook processing, payout jobs, push notification dispatch, nightly ledger reconciliation, withdrawal-slab batch jobs.
- Run workers as a separate process/deployment from the Express API — keeps a slow job from ever blocking request handling, and lets you scale workers and API independently.

---

## 6. Realtime transport

- **Socket.io** with `@socket.io/redis-adapter` — handles call signaling (ringing/accept/reject/ICE relay if self-hosting), presence broadcast, 1:1 chat delivery, live-broadcast chat fan-out. The Redis adapter is what makes this work once you run more than one API instance.

---

## 7. Auth & security

- **Access/refresh JWTs** — `jsonwebtoken`, short-lived access token + rotating refresh token, refresh tokens stored server-side (Redis or a DB table) so they can be revoked (needed for ban/suspend to actually take effect immediately).
- **Password/PIN hashing** (if you have any password-based login): `argon2` over `bcrypt` — stronger default, still well-supported in Node.
- **OTP for phone auth** (likely primary auth method for both user and host apps): a provider's Verify API (Twilio Verify, MSG91, etc.) rather than hand-rolling OTP storage/expiry — offloads SMS delivery reliability and fraud-rate-limiting to them.
- **Validation**: **Zod** for all request DTOs — pairs well with TypeScript (infer types from schemas instead of maintaining both), and is what you'll also reuse for validating webhook payloads and env vars.
- **`helmet`** for HTTP security headers, **`cors`** configured to the known app origins (or none, if these are pure mobile apps hitting the API directly with bearer tokens — no browser cookie flow means no CSRF surface to worry about).
- **`express-rate-limit`** (Redis store) on auth/OTP endpoints specifically — these are the most common abuse target.

---

## 8. Payments, video, storage, notifications (external SDKs)

| Concern | Suggested provider(s) | Node integration |
|---|---|---|
| Recharge + payouts | Razorpay or Cashfree (high-risk tier — see BACKEND_PLAN.md §3) | Official Node SDK for order/payout creation; raw `express.raw()` body parsing + HMAC verification for webhook routes (never JSON-parse before verifying signature) |
| Video calls + live broadcast | **Agora** (decided — see BACKEND_PLAN.md §4; ZEGOCLOUD is the fallback if pricing doesn't work out; Twilio Video is ruled out, sunset by Twilio) | `agora-token` (Node) to mint short-lived join tokens per call/broadcast server-side; webhook endpoint for call/recording events |
| 1:1 and live chat | **Self-built**, not a vendor product — Socket.io + Postgres (history) + Redis (fan-out), see BACKEND_PLAN.md §4 | n/a — this is our own code, not an SDK integration |
| Object storage | AWS S3 or Cloudflare R2 (cheaper egress) | `@aws-sdk/client-s3` (R2 is S3-API-compatible, same client) — pre-signed upload URLs for KYC docs/gallery images so large files never transit through Express itself |
| Push notifications | Firebase Cloud Messaging | `firebase-admin` |

---

## 9. Observability & testing

- **Logging**: `pino` + `pino-http` — structured JSON logs, fast, plays well with any log aggregator.
- **Error tracking**: Sentry Node SDK — wire it into the Express error middleware and the BullMQ workers separately (job failures need their own visibility, not just request errors).
- **Metrics**: `prom-client` exposing a `/metrics` endpoint for Prometheus/Grafana, or a hosted equivalent (Better Stack, Datadog) if you'd rather not run the Prometheus stack yourself early on.
- **Testing**: `vitest` (or `jest`) + `supertest` for API tests; a dedicated Neon branch as the test database so tests run against real Postgres semantics, not a mock.
- **API docs**: generate OpenAPI from the Zod schemas (`zod-to-openapi`) + `swagger-ui-express` — keeps the docs from drifting out of sync with the actual validation.

---

## 10. Deployment & CI/CD

- **Containerize** the API and the BullMQ worker as separate Docker images/processes from day one, even before you need to scale them independently — retrofitting that split later is more painful than starting with it.
- **Hosting**: Railway, Render, or Fly.io are the fastest path to production for a Node/Express + Neon + Redis stack and all support the sticky-session/multi-instance needs of Socket.io reasonably well; move to AWS ECS/Fargate later if you need more infra control. Whichever you pick, confirm it supports WebSocket connections cleanly (some serverless-function-style platforms don't).
- **CI**: GitHub Actions — run typecheck, lint, tests (against an ephemeral Neon branch), and migration dry-run on every PR.
- **Env config**: `dotenv` + a Zod-validated env schema loaded at boot, so a missing/malformed env var fails fast at startup instead of surfacing as a runtime error mid-request.

---

## Summary package list

```
express, typescript, tsx
drizzle-orm, drizzle-kit, pg
ioredis, bullmq
socket.io, @socket.io/redis-adapter
jsonwebtoken, argon2, zod
helmet, cors, express-rate-limit
razorpay (or cashfree-pg), agora-token
@aws-sdk/client-s3, firebase-admin
pino, pino-http, @sentry/node, prom-client
vitest, supertest, zod-to-openapi, swagger-ui-express
```

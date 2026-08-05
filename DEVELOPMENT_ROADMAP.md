# Development Roadmap — Phases, Timelines & Frontend Handoff Points

Companion to [`BACKEND_PLAN.md`](BACKEND_PLAN.md) (domain design) and [`tech-stack/TECH_STACK.md`](tech-stack/TECH_STACK.md) (stack choices). This document answers a different question: **in what order do we build it, how long does each piece take, and at what point can each frontend app start building against it.**

Timelines assume **one backend developer working full-time**, moderate familiarity with the chosen stack. Add parallel backend engineers and phases 4/7/9 (the largest ones) compress the most; the rest are less parallelizable since they're mostly sequential dependencies on the wallet/ledger core.

---

## 0. Working model: contract-first, so frontend is never blocked waiting

The single biggest risk to a "backend built separately from three frontends" project is frontend sitting idle waiting for endpoints to exist. Avoid it like this:

1. **Every phase starts with an API contract, not code.** Before implementation, publish the request/response schema (OpenAPI, generated from the Zod DTOs per `tech-stack/TECH_STACK.md` §9) for that phase's endpoints, plus a mock server (or a Postman mock collection) that returns realistic fake data matching the contract exactly.
2. **Frontend builds against the mock immediately.** They don't wait for real implementation — they wire up screens, loading/error states, and socket event handlers against the mock/contract from day one of the phase.
3. **Backend implements behind the same contract.** When real implementation lands on a shared staging environment, frontend just swaps the base URL — no rework, because the contract didn't change, only what's behind it.
4. **A single shared source of truth**: one Swagger/OpenAPI UI + one Postman workspace, updated every phase, that all three frontend teams point to. This is the one artifact worth keeping meticulously in sync — everything else in this roadmap depends on it actually being trustworthy.

This means the timeline below has two tracks per phase: **"contract ready"** (frontend can start) and **"staging ready"** (frontend can integrate against the real thing) — they're usually a few days to a week apart, not the same day.

---

## 1. External lead-time items to start on day 1, regardless of dev phase

These are outside your control and have their own clock — kick them off immediately so they don't become the actual bottleneck later:

- **High-risk payment gateway application** (BACKEND_PLAN.md §3) — approval for adult-content-adjacent merchant accounts can take days to several weeks and needs business documents, not code. Start this in week 1.
- **Video/live CPaaS vendor account** (Agora/100ms/ZEGOCLOUD) — account setup, sandbox keys, and understanding their webhook/recording pricing. Fast, but do it early since Phase 4/7 depend on it.
- **Apple/Google developer accounts** for whichever frontend team needs push notification certs (FCM/APNs) — not your deliverable, but flag it, since a late push-cert request has stalled more than one launch.

---

## 2. Phase-by-phase plan

| Phase | Backend delivers | Frontend can build in parallel | Testing focus before moving on | Est. duration |
|---|---|---|---|---|
| **0. Foundations** | Repo/CI scaffold, Neon DB + branch strategy, env config, base Express app, error handling middleware, OpenAPI/Postman skeleton | Nothing yet — this is pure infra | CI pipeline runs green, health-check endpoint live on staging | ~1 week |
| **1. Auth & profiles** | Phone/OTP auth, JWT issue/refresh, role model (USER/HOST/ADMIN), basic profile CRUD, KYC document upload (storage only, no verification workflow yet) | Login/OTP screens, profile edit screens (all 3 apps), KYC upload UI | Auth contract tests, token expiry/refresh edge cases, KYC file upload against real S3/R2 | ~2 weeks |
| **2. Wallet, ledger, recharge** | `UserWallet`, `LedgerEntry`, gateway order creation, webhook handler + signature verification, reconciliation job skeleton (BACKEND_PLAN.md §1–2) | Recharge screen (amount picker → gateway checkout SDK handoff), wallet balance display | **This is the phase to test hardest** — idempotency (replayed webhooks), race conditions (concurrent recharges), reconciliation job catching a deliberately-dropped webhook | ~2.5 weeks |
| **3. Host presence & discovery** | Online/available/busy state (Redis-backed), host list API (filter/sort/paginate), rate-per-minute field on host profile | User app's host list/browse screen, host app's online/offline toggle | Presence updates propagate live via socket within an acceptable latency budget (define one, e.g. <1s) | ~1 week |
| **4. Calls: signaling + per-minute billing** | Call state machine, CPaaS token issuance, billing-tick job (server-authoritative), pre-call balance gate, commission snapshot, low-balance warning + graceful auto-end | Call UI (ringing/accept/reject/ongoing screens), in-call balance/timer display, both user and host call screens | **Money-critical — heaviest test phase.** Simulated network drop mid-call, balance hitting exactly zero mid-tick, concurrent calls from the same user (should be blocked), reconciliation of billed amount vs ledger sum | ~3 weeks |
| **5. Chat (1:1)** | Message send/receive over socket, persisted history API, push notification on offline recipient | Chat UI in user app + host app | Message ordering/delivery under reconnect, offline push fires correctly | ~1.5 weeks |
| **6. Gifting** | Gift catalog CRUD (admin), send-gift transaction (same debit/commission/credit pattern as billing), gift-request popup event | Gift picker UI, "host asks for gift" popup UI | Gift send reuses the ledger correctly — verify no separate code path silently bypasses commission logic | ~1 week |
| **7. Live broadcasting** | Broadcast start/stop, viewer join/leave tracking, live chat fan-out, gifting-in-live (reuses Phase 6 pipeline) | Live viewer UI (user app), go-live UI (host app), live chat overlay | Load test with realistic concurrent-viewer counts on one broadcast, chat fan-out latency under load | ~2 weeks |
| **8. Withdrawals/payouts** | Withdrawal request flow, KYC-gated payout details, withdrawal slabs, auto-approve threshold, gateway payout API + webhook | Host earnings dashboard, withdrawal request UI, status tracking | Slab conversion correctness at tier boundaries, failed-payout beans-reversal path | ~1.5 weeks |
| **9. Admin panel APIs** | KYC approval queue, commission/beans-rate/slab config, withdrawal approval queue, moderation queue, RBAC for sub-admins, audit log, analytics endpoints | Full admin app (this is likely its biggest phase on the frontend side) | RBAC boundary tests (sub-admin can't touch what they shouldn't), audit log completeness | ~2 weeks |
| **10. 18+ toggle & capture-event hooks** | `AdultModeConfig` flag + content filtering, `secure_mode` flag exposure, `/moderation/capture-event` endpoint + policy actions | Frontend enforcement of `FLAG_SECURE`/capture detection (BACKEND_PLAN.md §5 — this is frontend-owned, backend only configures/logs) | Verify age-gated content is actually filtered when the flag is on, capture-event logging triggers correct policy escalation | ~0.5–1 week |
| **11. Hardening** | Fraud/velocity rules, device-fingerprint checks, full reconciliation automation, rate limiting tuned on real traffic shapes, load testing the billing-tick path and live broadcasts, security review pass | Bug-fix cycles across all 3 apps against real staging data | Load test targets defined and met (e.g. N concurrent calls, M concurrent live viewers), security review findings closed | ~2 weeks |
| **12. UAT / beta / staged rollout** | Staging → production cutover, feature-flag-gated rollout (start with a small % of real users), monitoring dashboards live (Sentry/Prometheus per tech-stack §9) | Final polish, crash/error monitoring integration in-app | Real-money smoke test with small real transactions before full rollout, on-call runbook ready | ~1.5–2 weeks |

**Total: roughly 21–24 weeks (~5–6 months)** end-to-end for one backend developer, from empty repo to a hardened production rollout — not counting whatever the payment gateway's approval process adds on its own clock (§1 above), which should overlap with Phases 0–3 rather than sit on the critical path.

---

## 3. Sequencing rules worth calling out explicitly

- **Phases 0–4 are strictly sequential** — auth → wallet → presence → calls is the actual money-moving core loop, and each one is a real dependency of the next (you can't bill a call without a wallet, can't have a wallet without an authenticated user). Don't let frontend pressure push these out of order; the mock-contract approach in §0 is what relieves that pressure instead.
- **Phases 5–8 are more parallelizable** once Phase 4 is stable — chat, gifting, live, and withdrawals don't depend on each other, only on the wallet/ledger core. If you add a second backend engineer, this is where they'd start.
- **Phase 9 (admin) can actually start earlier than the table implies** for the *config* pieces specifically (commission %, beans rates, 18+ toggle) — those are needed by Phase 2/4 anyway, so it's worth pulling minimal admin-config CRUD into Phase 2 rather than waiting, and building the rest of the admin app (moderation, analytics, full dashboards) later as shown.
- **Don't skip the Phase 4 test focus for schedule pressure.** A bug in chat or gifting is an annoyance; a bug in the billing tick is a direct financial loss or a support/legal problem — the extra time budgeted there is deliberate, not padding.

---

## 4. What to hand the frontend teams at kickoff

- This roadmap, so each app's team knows which phase unblocks their next screen.
- The shared OpenAPI/Postman workspace (§0), updated at the start of every phase before implementation begins.
- A staging environment URL + a set of seeded test accounts (per role) they can log into from day one of Phase 1 onward.
- Clear ownership note on the screenshot/recording restriction: it's a **frontend-implemented** control (`FLAG_SECURE` on Android, capture-detection on iOS) that the backend only configures and logs — make sure whichever team owns the user/host apps knows this isn't something the backend "just handles."

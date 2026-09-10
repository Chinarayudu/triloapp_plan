# Video Chat Platform — Backend Architecture Plan

Three client apps (built by others), one backend to serve all three:

| App | Role | Core needs |
|---|---|---|
| User App | `USER` | recharge wallet, browse available hosts, video call (per-minute billed), chat, gift, watch/join live broadcasts |
| Host App ("girls") | `HOST` | go online/offline, receive/accept calls, chat, live broadcast, earnings (beans), withdraw, send gift-request popups |
| Admin App | `ADMIN` / `SUB_ADMIN` | KYC, pricing/commission config, withdrawal approval, moderation, 18+ toggle, analytics |

---

## 1. Money Model — get this right first

This is the highest-risk part of the system. The model is intentionally **asymmetric** between the two sides:

- **User wallet** — denominated directly in real currency (₹/whatever). No "coins" abstraction: the user recharges ₹500 and sees a ₹500 balance, full stop. Deductions during a call are simply `host.rate_per_min × minutes`, in the same currency. Internally, store the balance in the smallest currency unit (e.g. paise) to avoid floating-point drift — that's an implementation detail, never surfaced to the user as a separate unit.
- **Beans** — what HOST wallets hold. When a call/gift is billed, the user's currency is debited, commission is taken, and the **net amount is credited to the host as beans** (not cash). This is the one deliberate internal-currency layer in the system — it exists so admin can control payout economics (conversion rate, slabs/tiers, promotions) independently of what the user ever sees.
- At withdrawal time, the host converts beans → real currency using admin-configured **slabs** (e.g. tiered rates: higher bean volumes unlock a better ₹-per-bean rate) rather than one flat rate.
- Real money touches the system at exactly two edges: **recharge** (gateway → user wallet, 1:1) and **withdrawal** (beans → payout, via slab conversion). Everything in between — billing, commission, gifting — is internal ledger movement.

### Double-entry ledger (non-negotiable for production)

Never mutate a `balance` column directly. Every change is a `LedgerEntry` row; the wallet balance is either a cached derived value reconciled by a job, or computed from the sum. This is what makes disputes, refunds, and audits possible later.

```
LedgerEntry {
  id, wallet_id, wallet_type[USER_WALLET|HOST_BEAN],
  direction[DEBIT|CREDIT], amount,
  reference_type[RECHARGE|CALL_BILLING|GIFT|COMMISSION|WITHDRAWAL|REFUND|ADJUSTMENT],
  reference_id, balance_after, idempotency_key, created_at
}
```

Every mutating operation (recharge webhook, billing tick, gift send, withdrawal) carries an **idempotency key** so retries (webhook redelivery, client retry, crashed job resume) never double-apply.

### Per-minute call billing engine

Client-reported time is never trusted — the server is the sole authority on call duration and money.

1. **Pre-call gate**: before a call is allowed to connect, check `user.wallet_balance >= host.rate_per_min * MIN_BUFFER` (e.g. 1–2 minutes worth, in currency). Reject/queue otherwise.
2. **Billing tick**: once `ONGOING`, a server-side scheduled job (not the client) deducts currency every N seconds (e.g. every 10s, pro-rated off `rate_per_min`) inside a transaction that:
   - acquires a short-lived Redis lock on the user's wallet,
   - debits the user's currency wallet,
   - computes commission (`CommissionConfig` active at call start — snapshot the rate on the call row so later admin changes don't retroactively alter in-flight/settled calls),
   - converts the net (post-commission) amount to beans at the current earn-side conversion rate and credits the host's bean wallet,
   - writes matching `LedgerEntry` rows,
   - checks resulting balance — if it would go negative, ends the call at the last fully-paid tick instead of over-drafting.
3. **Low-balance handling**: push a socket warning at a threshold (e.g. 30s of runway left); auto-end gracefully at zero, never mid-tick.
4. **Reconciliation job**: nightly job sums `LedgerEntry` per wallet and compares to cached balance; alerts on drift instead of silently trusting the cache.

### Gifting & gift-requests — built (Phase 6)

- Gifts are a catalog (`gifts{name, pricePaise, active}`) priced in real currency, managed by admin (no admin UI yet — seeded via `npm run db:seed`) — same principle as the wallet: the user picks a gift priced in ₹, not in an abstract unit.
- Sending a gift debits the sender and credits the recipient host's beans through `wallet.service.ts`'s `transferUserToHost` — the exact same primitive call billing uses, not a parallel reimplementation. That function was extracted specifically so the debit/commission/credit math can't drift between the two call sites; tagged `reference_type=gift` in the ledger. `context`/`contextId` optionally tag which call/chat/live instance a gift happened during, but nothing enforces that instance must still be active.
- "Ask for gift" (`POST /gifts/request`, host-only) is just a targeted real-time event (socket + push-notification fallback) to the user with an optional suggested gift; it doesn't move money itself, it just prompts the user's client to open the gift picker.

### Withdrawals — built (Phase 8)

- `withdrawal_requests{host_id, beans, paise_per_bean_snapshot, converted_amount_paise, status, payout_details_snapshot, payout_txn_id, failure_reason}` — `PENDING → APPROVED → PROCESSING → PAID`, or `→ REJECTED` (from pending) / `→ FAILED` (from processing).
- `converted_amount_paise` is computed via the **withdrawal slab table** (`withdrawal_slabs`, tiered by bean range) active at request time — a different rate than the one used when beans were earned; this is where admin controls the actual payout economics. `withdrawal_policy_configs` holds the minimum amount, frequency cap, and auto-approve threshold as one admin-tunable snapshot (BR-EARN-04/05).
- Requires the host's KYC to be `approved` and `host_profiles.payout_details` (UPI or bank, `PATCH /me/payout-details`) to be set before a request can be created (BR-EARN-03).
- Beans are debited at request time (not at final payout) — this is what prevents the same beans from being withdrawn twice while a request is in flight — and reversed on `REJECTED` or `FAILED` (BR-EARN-06).
- Auto-approve under the admin-set threshold (`converted_amount_paise <= autoApproveThresholdPaise`), manual queue (`PENDING`) above it.
- **Not yet real**: the actual gateway Payout/Transfer API call and its webhook. Razorpay payout credentials aren't verified (same blocker as recharge, §2/§3) — `src/lib/payout.ts` dev-stubs the gateway call the same way `src/lib/otpSender.ts` dev-stubs SMS (loud failure in production, logged in dev/test). `POST /withdrawals/:id/dev-resolve-payout` stands in for the missing webhook — a non-prod-only escape hatch, same pattern as `POST /wallet/dev-credit`. The admin approval queue itself is real now (Phase 9, below) — `POST /admin/withdrawals/:id/decision` replaced the old `dev-admin-decision` stand-in.

### Admin panel — built (Phase 9)

- `src/modules/admin/` — KYC approval queue (`GET /admin/kyc/pending`, `POST /admin/kyc/:userId/decision`; approving also sets `ageVerified` when a `dob` is on file, per BR-ACC-04), withdrawal approval queue (`GET/POST /admin/withdrawals...`), pricing/economics config CRUD for commission, beans earn-rate, withdrawal policy, and withdrawal slabs (all append-only "insert a new versioned row" — never updated in place, same reasoning as the `_snapshot` fields in §6), gift catalog CRUD (previously seed-only), account suspend/ban/reactivate (BR-ACC-05), and an analytics dashboard (`GET /admin/dashboard`, BR-ADM-01 — real aggregate queries against calls/gifts/wallets, not placeholder numbers). Replaced two now-removed dev-only escape hatches: `POST /me/kyc/dev-approve` and `POST /withdrawals/:id/dev-admin-decision`.
- **Sub-admin RBAC (BR-ADM-03)**: `users.permissions` (`finance` / `moderation` / `analytics`) is only meaningful for `role=sub_admin` — a full `ADMIN` has every permission implicitly. `admin/permissions.ts`'s `requireAdminPermission` checks the DB on every request rather than trusting the JWT, so a permission change takes effect on the sub-admin's very next request, not their next login. Sub-admin accounts are created via `POST /admin/sub-admins`, ADMIN-only (not delegable to another sub-admin).
- **Admin provisioning**: there is still no signup flow for `role=admin`/`sub_admin` — by design, an admin account isn't something anyone should self-register. The first admin account is provisioned out-of-band via `npm run db:seed-admin -- +91...` (`src/db/seedAdmin.ts`), then authenticates through the same `/auth/otp` flow as everyone else; every subsequent sub-admin is created through the real `POST /admin/sub-admins` endpoint above.
- **Moderation reports (BR-MOD-04/05)**: `src/modules/moderation/` — any authenticated User/Host can file a report (`POST /moderation/reports`) against another account or a piece of content; it lands in `GET /admin/moderation` for a moderation-permission admin to resolve. Resolving a report never suspends an account by itself (not every report warrants one) — suspension is the separate, explicit `POST /admin/users/:id/status` action.
- **Audit log (BR-ADM-04)**: every mutating admin action above calls `src/lib/auditLog.ts`'s `writeAuditLog` — who, what, when, reviewable via `GET /admin/audit-log`. Never edited or deleted.
- **Account suspension's real reach (BR-ACC-05)**: `setAccountStatus` revokes every refresh token the account holds (blocks new logins/refreshes immediately) and force-disconnects any live Socket.io connection (`realtime/socket.ts`'s `disconnectUser`). The one gap this doesn't close: an already-issued access token (15-minute TTL) still works for plain REST calls until it naturally expires — there's no cheaper way to invalidate that without a per-request DB check on every route, which wasn't judged worth the cost for a 15-minute window.

---

## 2. Automating recharge & payouts — no manual step per user

This is the part that makes "just click a button" true at any scale: the payment gateway does the actual instrument handling (card/UPI/netbanking), and our backend never sits in the loop as a manual step — it only reacts to gateway events.

### Recharge (user taps "Add ₹500")

1. App calls `POST /wallet/recharge/initiate {amount}`. Backend creates an **order** via the gateway's Order API (Razorpay/Cashfree `orders.create`), storing `RechargeTxn{status=CREATED}` keyed to that order id, and returns the order details to the client.
2. Client opens the gateway's **hosted checkout SDK** — this is a pre-built UI the gateway ships (supports UPI/card/netbanking/wallets as one flow). We never build our own card-entry screen, and must not: handling raw card numbers ourselves pulls the whole backend into PCI-DSS scope for no benefit.
3. User authorizes inside that UI — UPI PIN, card OTP, or a saved method/UPI-autopay for true one-tap on repeat recharges.
4. Two confirmations follow, and only one of them is trusted:
   - **Client-side callback** — fires instantly, fine for optimistic UI ("updating balance…"), but a compromised/rooted client could fake this, so it never credits money by itself.
   - **Server-side webhook** — the gateway calls our backend directly with a signed payload. This is the *only* thing that credits the wallet: verify the signature → check the order id hasn't already been processed (idempotency) → credit the wallet via the ledger → mark `RechargeTxn=SUCCESS`.
5. **Reconciliation job**: webhook delivery isn't 100% guaranteed, so a periodic job polls the gateway's transaction-status API for any `CREATED` order still unresolved after a couple minutes, and settles it from there. This closes the one gap that could otherwise leave a payment "stuck" without a human noticing.

Result: every recharge, for every user, completes with zero backend/admin intervention — steps 1–5 are pure automation, the gateway absorbs the hard part (payment instruments), and the webhook + reconciliation pair makes it reliable without anyone watching.

### Payout (host taps "Withdraw") — same idea, reversed

1. Request is auto-approved if under the admin-set threshold (§1) and the host's payout details are KYC-verified — no human touches it.
2. Backend calls the gateway's **Payout/Transfer API** with the host's saved verified bank account/UPI VPA. No manual bank transfer, ever.
3. Gateway webhooks back on success/failure; backend updates `WithdrawalReq.status` (`PROCESSING → PAID`, or `→ FAILED` with the beans reversed back to the host's balance).
4. Above the auto-approve threshold, the *only* manual step is a person in the admin app clicking "Approve" as a fraud checkpoint — the money movement itself is still gateway-automated once approved, not a manual bank transfer.

### Why this scales to "everyone" with just clicks

- The gateway — not our backend — is what scales to concurrent card/UPI throughput. Our side only ever does two cheap, stateless, horizontally-scalable things: create an order/payout, and process a webhook.
- **Tokenization** (saving a card/UPI mandate in the gateway's vault, not in our DB) is what makes *repeat* recharges single-tap without re-entering payment details — we store a token reference, never raw instrument data.
- The only human-in-the-loop point anywhere in this system is the optional withdrawal-approval queue above threshold — recharge is fully touchless by design, and payout can be too, below threshold.

---

## 3. ⚠️ Decision that affects everything else: payment gateway for adult content

This needs to be resolved before building the payment module, not after. Mainstream processors (Stripe, PayPal, and most standard Razorpay/Cashfree/PayU merchant categories) **prohibit or heavily restrict adult/webcam content** in their terms — even with a toggleable 18+ flag, if any content on the platform can be adult-rated, you're generally in "high-risk merchant" category. Getting a standard account and then having it frozen mid-operation after volume picks up is a common failure mode for platforms like this.

Practical paths:
- Apply as a **high-risk merchant** with processors that explicitly support adult/cam platforms (there are specialized high-risk payment processors for this vertical — regional options vary by country).
- Or structure recharge as a generic "digital goods/coins" purchase and keep the adult toggle content-side only, understanding this doesn't eliminate the ToS risk, just reduces how it looks on paper.
- This is a legal/business decision as much as a technical one — worth a conversation with a payments-savvy lawyer before committing to a specific gateway integration.

I'll assume **India-first (Razorpay/Cashfree high-risk tier)** unless you tell me otherwise, since per-minute cam billing + beans withdrawal is a very India/SEA-common business model — but flag this early since it changes which SDK the payment module is built against.

---

## 4. Real-time infra: calls, live broadcast, chat, presence

### Video/audio calls (1:1) — decided: Agora

- **Managed CPaaS, not self-hosted**: building/operating an SFU + TURN fleet ourselves is a large distinct engineering problem that isn't worth taking on before the rest of the platform (payments, moderation, admin) even exists. Revisit self-hosting (LiveKit OSS, mediasoup + coturn) only once call-minute volume makes the per-minute vendor cost a real line item.
- **Agora** is the pick: it's the CPaaS most commonly used for this exact app category (per-minute cam calls + live streaming + gifting), bundles the 1:1 call product and the live-broadcast product under one SDK (no double integration), and has the deepest track record at this kind of scale.
  - **Fallback**: ZEGOCLOUD — explicitly targets this social/live-streaming/dating niche and tends to be cheaper at volume, smaller track record. Worth a pricing comparison once real call-minute volume estimates exist, but not worth blocking on now.
  - **Ruled out**: Twilio Video — Twilio sunset its Programmable Video product, so it's not a viable option regardless of fit.
- Our backend owns **signaling and business logic**, not media: call state machine (`REQUESTED → RINGING → ACCEPTED → ONGOING → COMPLETED/REJECTED/MISSED/FAILED`), ringing/timeout, billing hooks on connect/disconnect events from Agora's server-side callbacks/webhooks. Agora's server SDK issues short-lived join tokens per call; the backend never touches raw media.

### Live broadcasting (one host → many viewers) — built (Phase 7)
- Same vendor as calls (Agora) — the host's join token is `PUBLISHER` role, a viewer's is `SUBSCRIBER` (read-only), both minted by `generateAgoraToken`'s now-parameterized role — one CPaaS integration, not a separate vendor, and viewers can't accidentally publish.
- Backend tracks `live_broadcasts` (status, peak viewer count) and `live_viewers` (join/leave — `leftAt IS NULL` is what "currently watching" and the concurrent-viewer count actually mean, not a separate counter that could drift), and reuses `gifts.routes.ts`'s existing send-gift pipeline unmodified for in-broadcast gifts (`context: "live"`) — the only addition was also fanning the resulting `gift:received` event out to every viewer in the broadcast room, not just the host.
- Live chat fan-out is **self-built** over a Socket.io room (`live-<broadcastId>`), not the vendor's bundled chat product — consistent with 1:1 chat and under our own moderation/admin visibility. It is deliberately **not persisted** (unlike 1:1 chat) — BR-LIVE-02 only requires current visibility, not retrievable history; revisit if moderation/replay needs it later. Room membership is driven server-side from the join/leave REST endpoints (`Socket.io socketsJoin/socketsLeave` on the caller's already-connected socket), not by the client managing its own room state — one source of truth (`live_viewers`), not two systems that could disagree about who's actually watching.
- Redis pub/sub (mentioned in earlier drafts of this doc) turned out unnecessary for a single instance — Socket.io rooms already do this fan-out natively; Redis only becomes necessary via `socket.io-redis-adapter` once there's more than one server instance, same "in-memory now, swap later" story as presence and call scheduling.

### Presence
- Redis-backed online/available/busy/offline state per host, pushed to user app via WebSocket/pub-sub so the host list updates live without polling.
- Host list API: filter by available, sort by rating/price/recently-online, paginate.

### Chat (1:1) — built (Phase 5): self-built, not a third-party service
- Persisted message history in Postgres (`chat_conversations` + `chat_messages`), delivered live over Socket.io via the same per-user-room mechanism calls/presence already use, push notification when recipient has no live connection.
- Deliberately not routed through Agora Chat or another vendor messaging product — 1:1 chat is where gift-requests are triggered and where moderation/reports originate, so keeping it in our own DB keeps that fully under our control rather than split across systems.
- Free by default (open decision #3 resolved this way for now) — a per-message billing hook would reuse the same currency-debit/bean-credit pattern as calls and gifts if the business wants it metered later.
- Push notifications are stubbed (dev-mode logging) pending FCM credentials — same pattern as the OTP/Agora/S3 stubs elsewhere in this doc.

---

## 5. Screenshot/recording restriction & 18+ toggle — built (Phase 10)

**Screenshot/screen-recording prevention is fundamentally a client-side control; the backend cannot enforce it, only configure and react to it.**
- Android: client sets `FLAG_SECURE` on the sensitive activity/view — this is the actual block, and it's a frontend task.
- iOS: there is **no OS-level API to block screen recording**. The best available is detecting `UIScreen.capturedDidChangeNotification` and reacting (blur the view, end the call) — again frontend-side.
- Backend's role, built: a **`secureMode` flag** on call and live-broadcast-join responses the client reads and enforces (`calls.routes.ts`, `live.routes.ts`) — `true` unconditionally for 1:1 calls (this whole platform is treated as sensitive-by-default, §3), and per-broadcast (`isAdultContent`) for live. `POST /moderation/capture-event` (`moderation.routes.ts`) is what the client calls when it detects a capture attempt — logs it (`capture_events`), and past a threshold (4 events) auto-**files a moderation report** for a human admin to review (`moderationReports`, reused from Phase 9), rather than auto-suspending: capture detection can false-positive (e.g. a legitimate OS screenshot on some Android versions), so the actual suspend/ban decision stays an explicit human action, same as any other report (BR-MOD-05). `GET /admin/capture-events` gives an admin the raw log underneath that.

**18+ toggle — built**:
- `adult_mode_configs.enabled` (`admin.service.ts`) is a global feature flag, versioned the same "insert a new row" way as commission/beans-rate/withdrawal config — `GET/POST /admin/config/adult-mode` (moderation permission, not finance: this is a content-policy lever). `GET /live/adult-mode` is the public read any authenticated role can check.
- Scoped to content, not just global: `live_broadcasts.isAdultContent` (BR-MOD-01's "and/or scoped to specific broadcasts") — a host can only set it on `POST /live/broadcasts` if the global toggle is currently on *and* the host is age-verified; it then stays true for that broadcast's lifetime regardless of a later global flip (a later admin change never retroactively re-opens already-gated content).
- **Age verification (BR-MOD-02)** reuses Phase 9's KYC approval rather than a self-declared checkbox: `decideKyc`'s KYC approval sets `users.ageVerified = true` when a `dob` is on file (BR-ACC-04) — the same real human-reviewed document check as the rest of KYC, not a separate flow. `listLiveBroadcasts` filters adult broadcasts out of the discovery list for unverified viewers, and `joinBroadcast` gates the actual join (the point that mints the Agora subscriber token) the same way — two enforcement points, not one, so an unverified viewer can neither discover nor access gated content.

---

## 6. Data model (core entities)

```
User            (id, role[USER|HOST|ADMIN|SUB_ADMIN], phone, email, dob, age_verified, kyc_status, status)
HostProfile     (user_id, rate_per_min, rating, bio, gallery, payout_details, is_online, is_busy)
UserWallet      (user_id, balance)                          -- real currency, smallest unit internally
HostWallet      (host_id, bean_balance)
LedgerEntry     (wallet_id, wallet_type, direction, amount, reference_type, reference_id, balance_after, idempotency_key)
RechargeTxn     (user_id, amount, gateway, gateway_txn_id, status)   -- amount credited 1:1, no conversion
WithdrawalReq   (host_id, beans, slab_id_snapshot, converted_amount, status, payout_txn_id)
CallSession     (user_id, host_id, status, start_time, end_time, rate_per_min_snapshot, commission_pct_snapshot, earn_rate_snapshot, total_amount, total_beans)
CallBillingTick (call_id, tick_time, amount_deducted, beans_credited)
LiveBroadcast   (host_id, status, start_time, end_time, peak_viewers)
LiveViewer      (broadcast_id, user_id, joined_at, left_at)
ChatMessage     (sender_id, room_id, content, type, created_at)
Gift            (name, icon, price, active)                 -- priced in currency
GiftTxn         (sender_id, receiver_id, gift_id, context[CALL|CHAT|LIVE], amount, beans)
GiftRequest     (host_id, user_id, context, status)
CommissionConfig(scope[GLOBAL|HOST], percentage, effective_from)
BeansEarnConfig (currency_per_bean, effective_from)          -- rate used when crediting hosts
WithdrawalSlab  (min_beans, max_beans, currency_per_bean, effective_from)  -- tiered payout rates
AdminConfig     (adult_mode_enabled, feature flags...)
ModerationFlag  (reporter_id, target_type, target_id, reason, status)
AuditLog        (admin_id, action, target, timestamp)
```

Note the `_snapshot` fields on `CallSession` — rates, commission %, and the bean earn-rate all change over time via admin config, but a call already in progress or settled must keep the values active when it happened, not whatever's active now. The withdrawal slab used is separately snapshotted on `WithdrawalReq` at request time, since that conversion happens later and independently of when the beans were earned.

---

## 7. Suggested stack

**Confirmed: Node.js + Express + PostgreSQL (Neon).** Full package-level detail — ORM choice, connection pooling on Neon, Redis provider, job queue, SDK choices for payments/video/storage, observability, deployment — lives in [`tech-stack/TECH_STACK.md`](tech-stack/TECH_STACK.md), kept separate from this domain-design doc so the two can evolve independently.

---

## 8. Production concerns worth flagging now

- **Fraud** — built (Phase 11): `src/modules/moderation/fraud.service.ts`. Two signals, both conservative — they file into the same moderation report queue Phase 9 built (BR-MOD-04) for a human to review, never auto-suspend (a false positive here shouldn't cost someone their account). **Multi-accounting** (a host self-calling from a second account to farm earnings, or a banned user re-registering): `login_events` records every login with an optional client-supplied `deviceFingerprint`; once 3 distinct accounts share one fingerprint within 30 days, the account that crossed that threshold gets flagged — fires exactly once per crossing, not on every subsequent login. **Collusion** (user/host running up call minutes exclusively with each other): once a host has 5+ completed calls and 80%+ of them are with the same single user, the host gets flagged, checked right after `endCall`/the stale-call reaper's `completed` transition. Both require nothing from the client beyond what it already sends (deviceFingerprint is opt-in, same "configure/react, can't force" posture as §5's capture-event flag) — chargeback-after-spend abuse isn't addressed here, since there's no real payment gateway integrated yet to charge back against (§2/§3).
- **Mid-call failure** — built (Phase 11): `src/modules/calls/callReaper.ts`. In-memory billing-tick/ringing-timeout state (`callTimers.ts`) doesn't survive a process restart — a call left "ongoing" with no live timer would otherwise sit stuck forever, never over-charging further but never resolving either. The reaper runs once at boot (recovers anything stuck from before this process started) and then on an interval (`CALL_REAPER_INTERVAL_MS`, default 60s) as a backstop for a timer that dies without a restart — it only ever looks at how stale a call row's own timestamp is, never trusts in-memory state, so it can't double-charge or race a call that's genuinely still mid-tick (thresholds are generous multiples of the real timeouts).
- **Ledger reconciliation** — built (Phase 11): `src/modules/wallet/reconciliation.service.ts`, `GET /admin/reconciliation` (finance permission) for on-demand checks, plus an hourly background sweep (`WALLET_RECONCILIATION_INTERVAL_MS`) that logs at error level if any wallet's cached balance and its own ledger history disagree. This is the §1 "reconciliation job" for the ledger-vs-cache side; the gateway-webhook-vs-`RechargeTxn` side described there still doesn't apply — there's no real payment gateway integrated yet (§2/§3).
- **Rate limiting** — built (Phase 11): `src/middleware/rateLimit.ts`'s `perUserRateLimit`, keyed by authenticated user id (not IP, so a shared network doesn't get unfairly throttled and rotating IPs doesn't dodge it) — applied to call-initiation, gift-sending, and the two moderation endpoints, on top of the pre-existing OTP-request limiter. In-memory store, same single-instance tradeoff as presence/call-timer state below; these are conservative, generous-headroom limits picked by judgment, not tuned against real traffic shapes — there isn't any yet.
- **Horizontal scaling of realtime**: WebSocket/signaling nodes need a shared adapter (Redis) for pub/sub across instances — a single-node assumption breaks the moment you need 2 app servers. Still not built — Redis isn't provisioned anywhere in this repo yet (`tech-stack/TECH_STACK.md` scopes it, `presence.store.ts`/`callTimers.ts` are deliberately in-memory placeholders for it), and introducing it now, before there's an actual second instance to serve, would be infrastructure with no current consumer. Revisit when horizontal scaling is actually on the table.
- **Load testing / security review**: a local sanity check (25 concurrent calls, real 10s billing ticks, verified against `GET /admin/reconciliation`) confirmed the billing-tick path handles modest concurrency correctly on a single instance — that is **not** a substitute for a real load test against defined targets on a staging environment, which doesn't exist yet. A security-focused review pass of Phases 9–11 (RBAC, money-movement paths, SQL usage, IDOR) found no high-confidence findings.
- **RBAC for admin** — built (Phase 9, §1 above): separate `SUB_ADMIN` permission sets (finance/withdrawal approval vs moderation vs read-only analytics) rather than one flat admin role, with an audit log of every admin action — this is a money-and-content platform, every privileged action should be attributable.
- **Legal review**: adult content + real-money withdrawal + India-or-wherever jurisdiction is a genuine compliance surface (payment processor terms, data retention, age verification, possibly local licensing) — worth a short legal consult before the payment module is finalized, not after launch.

### Gap-closure pass — built

Found during an end-to-end testing pass after Phase 11 and closed immediately:

- **Per-host commission override (BR-COM-03)** — `commission_configs.hostId` (nullable — NULL is the global rate). `wallet.service.ts`'s `getCurrentCommissionBasisPoints(hostId?)` prefers an active host-specific row over global; every host with no override just falls through unaffected. `POST /admin/config/commission` (finance permission) accepts an optional `hostId` to set a negotiated rate for one host — e.g. a top earner — without touching anyone else's rate or the global default.
- **Notification coverage completed (BR-NOTIF-01)** — the BRD names five triggers; only chat-message and gift-request had a push fallback before this pass. Now also wired: incoming call, gift *received*, low-balance warning, and withdrawal status change — each emits its socket event as before, then falls back to `sendPushNotification` only if `isUserConnected` says the recipient has no live connection right now, same pattern as the two that already existed.
- **Host-follow feature (new)** — `host_follows` (many-to-many, USER→HOST), `src/modules/hosts/follow.service.ts`, `POST/POST /hosts/:hostId/follow` / `/unfollow`, `GET /me/following`. The fifth BR-NOTIF-01 trigger ("a followed/favorite host going live") had no feature behind it at all until now — `live.routes.ts`'s `POST /live/broadcasts` notifies every follower (socket + push fallback) the moment a host goes live.
- **CI was fully broken** — `.github/workflows/ci.yml` had no `JWT_SECRET` (env.ts requires it with no default, so the app couldn't even boot there) and no way to run the S3-dependent KYC/withdrawal tests (no AWS secret configured). Fixed: a placeholder test-only `JWT_SECRET`, and a MinIO container started as a plain `docker run` step (not GitHub Actions' `services:` block, which has no way to pass the `server /data` argument the official `minio/minio` image's entrypoint needs) standing in for real S3 — `src/lib/s3.ts`'s new optional `AWS_S3_ENDPOINT` override, unset in production, points the SDK at it. Verified locally: 109/109 tests passing (previously 91/105 without a local MinIO).

### Admin design follow-up — built

Found by reviewing the admin web app's Figma designs screen-by-screen against the built API and closing every gap immediately:

- **Admin login: email + password (BR-ADM-03)** — the design's actual admin login screen, not phone/OTP. `POST /auth/admin/login` (`auth.routes.ts`) looks up by `users.email`, verifies `users.passwordHash` (bcrypt, `src/lib/password.ts`), and returns the same generic "Invalid email or password" for both an unknown email and a wrong password so this can't be used to enumerate admin accounts. OTP login still works for admin/sub-admin too (unchanged) — this is an additional login path, not a replacement, since nothing in the design rules out keeping it for scripting/dev convenience. `npm run db:seed-admin` now takes three args (`phone email password`) instead of one.
- **Multi-attempt KYC with a real review screen (BR-ADM-05)** — KYC stopped being one column on `users` overwritten on every submission. `kycSubmissions` (one row per attempt, `attemptNumber`) + `kycDocuments` (1-4 documents per attempt: id_front/id_back/selfie/address_proof, each type once) replace the old single `kycDocumentKey` column. `GET /admin/kyc/:userId` is the design's "SUBMITTED DOCUMENTS" detail screen — every document on the latest pending attempt with a fresh 5-minute presigned view URL each. `POST/GET /me/kyc` (user-facing) updated to the same shape.
- **Host gallery, structured (new)** — `hostGalleryItems` (media type + optional video duration) alongside the existing bulk `gallery` URL array on `hostProfiles` (untouched, still works) — this is what lets the admin app view and moderate one gallery item at a time instead of an opaque URL list. Host: `POST/GET/DELETE /me/host-profile/gallery`. Admin: `GET /admin/hosts/:id/gallery`, `DELETE /admin/hosts/:id/gallery/:itemId` (moderation permission, audit-logged).
- **Users & Hosts roster + account detail screens (new)** — `GET /admin/users`, `/admin/hosts` (roster, with last-active derived from login history) and `GET /admin/users/:id`, `/admin/hosts/:id` (detail: profile, last-20 calls/gifts/chats involving the account from either side merged into one activity feed, moderation reports filed against them) — the admin design's account-detail screens had no backing endpoint before this pass.
- **Combined Dismiss/Warn/Suspend/Ban (BR-MOD-05)** — `POST /admin/moderation/:id/resolve` gained an optional `accountAction` (`warn`/`suspend`/`ban`) alongside `action` (`resolved`/`dismissed`), matching the design's single combined choice on the report screen instead of two separate requests. Only valid when the report targets an account, not content — validated before the report is resolved, so a bad `accountAction` never leaves the report resolved without the requested consequence applied. `warnAccount` (new) sends a socket notification + push fallback, same pattern as everything else in `realtime/socket.ts`.
- **Dashboard: period scoping, richer numbers (BR-ADM-01)** — `GET /admin/dashboard` gained `?from=&to=` (defaults to the last 30 days), `activeUsers`/`activeHosts` alongside the existing all-time totals, a daily `series` (revenue + call-minutes, for the design's chart), and `topEarningHosts` recomputed as *period-scoped earnings* (completed-call revenue + gifts received, within the window) rather than lifetime bean balance — the old version stayed "top earner" forever even after a host withdrew everything.
- **Audit log filters + previous-value tracking (BR-ADM-04)** — `GET /admin/audit-log` gained `adminId`/`from`/`to` filters. Every config-change audit entry (commission/beans-rate/withdrawal-policy/adult-mode) now records `{previous, new}` instead of just the new value, so the design's audit screen can show what actually changed, not just the end state.
- **Live broadcast admin monitoring (new)** — `GET /admin/live-broadcasts` (every currently-live broadcast, not age-gated, with host identity + live viewer count) and `POST /admin/live-broadcasts/:id/end` (force-end any host's broadcast for moderation, notifies the room over the socket, audit-logged) — the design's live-monitoring screen had no backing endpoint before this pass.
- **Broadcast messaging (new)** — `broadcastMessages` table, `GET/POST /admin/broadcast-messages` — a titled message to all Users, all Hosts, or both; delivered the same way as every other notification here (socket to whoever's connected, push fallback for whoever isn't), no queue.
- **18+ toggle restricted to full ADMIN only** — the design labels this screen "Accessible to Super Admin Only"; `GET/POST /admin/config/adult-mode` moved from `requireAdminPermission("moderation")` (any sub-admin with that permission) to `requireRole("admin")` (full admin, no sub-admin regardless of permissions).
- **Gift pricing stays real currency** — the design's mockup prices gifts in "beans," but beans are the *host's* internal earnings currency (BACKEND_PLAN.md §1); gifts are purchased by Users in real money. Confirmed with the business and kept as-is (paise) rather than introducing a second, conflicting meaning for "beans" — the design's labeling doesn't reflect the actual money model.
- Postman collection (`postman/TriloPlan-Backend.postman_collection.json`) updated for every endpoint above plus every changed request/response shape, and verified end-to-end with `newman` against a live server on a freshly migrated+seeded database: 108/108 requests, 28/28 assertions passing.

### Host app design follow-up — built

Found by reviewing the Host app's Figma designs screen-by-screen against the built API and closing every real gap immediately, same method as the admin pass above. A dev-only OTP bypass was added alongside this, since the Host/User apps have no real SMS delivery wired up yet.

- **OTP bypass for frontend dev (`OTP_BYPASS_VERIFICATION`)** — `env.ts`/`otp.service.ts`: when this flag is on (local `.env` only, `NODE_ENV=development` only — never production, never test), `POST /auth/otp/verify` accepts any phone + any 6-digit code with no prior `/otp/request` call needed. Scoped to `development` specifically (not just "not production") because `.env`'s dev-only settings are still loaded when `NODE_ENV=test`, and the test suite asserts real wrong-code/attempts behavior.
- **Ratings (BR-DIS-02)** — `call_ratings` (new table), `ratings.service.ts` — either call participant can rate the other once a call is `completed`; a host's aggregate rating (avg + count) is computed on read, not cached. `POST /calls/:id/rating`, merged into `GET /hosts` (new `sort=rating_desc`) and `GET /me`'s `hostProfile`. Nothing backed the design's "4.8★ · 126 calls" badges before this.
- **Block user** — `user_blocks` (new table), `blocks.service.ts`, `POST/DELETE/GET /moderation/blocks` — a safety tool distinct from `moderation_reports` (BRD lists "block/report" as two separate tools). Actually enforced: `calls.service.ts`'s `initiateCall` and `chat.service.ts`'s `resolveParticipants` reject with 403 between a blocked pair.
- **Call type (video/voice) + per-type rates** — `calls.type` enum column (defaults existing rows to `video`), `hostProfiles.voiceRatePerMinutePaise`/`privateLiveRatePerMinutePaise` (the latter stored ahead of any consuming feature, same precedent as the original `payoutDetails` placeholder). `POST /calls` accepts `type`; `initiateCall` picks the matching rate and 400s if the host hasn't set it. Backs the Rate Settings screen's separate video/voice/private-live rates and the Earnings Breakdown's video-vs-voice split.
- **Withdrawal fee/TDS breakdown (money path)** — `withdrawalPolicyConfigs.processingFeePaise`/`tdsBasisPoints` (admin-configurable, versioned like every other config here), `withdrawalRequests.processingFeePaise`/`tdsPaise`/`netPayoutPaise`. `requestWithdrawal` computes these from the gross `convertedAmountPaise` (beans debited are unaffected — always the full requested amount); `initiatePayoutForRequest` now sends the *net* amount to the payout gateway stub. Matches the confirm-withdrawal screen's Requested/Processing fee/TDS/Net payout breakdown.
- **Multiple payout methods** — `payout_methods` (new table) replaces `hostProfiles.payoutDetails` (single JSON blob, dropped). `payoutMethods.service.ts`, `POST/GET/DELETE /me/payout-methods`, `PATCH /me/payout-methods/:id/primary` — the first method added becomes primary automatically; withdrawal creation snapshots the primary method's details, same as before. Replaces the old `PATCH /me/payout-details`, no back-compat shim (same "replace, don't dual-write" convention as the admin pass's KYC rework).
- **Notification preferences** — `notification_preferences` (new table, one row per user, created at signup alongside the wallet row), `notificationPreferences.service.ts`, `GET/PATCH /me/notification-preferences`. Scope cut, stated explicitly: this is real persisted CRUD for the toggle screen; gating actual push sends on these preferences is not wired up yet (`push.ts` is still a dev-log stub with no real FCM provider, so gating a no-op wasn't judged worth doing yet).
- **Host earnings dashboard/breakdown/history (new)** — `wallet/earnings.service.ts` + `earnings.routes.ts`, all read-only aggregation over existing ledger/call/gift data, no schema changes: `GET /me/dashboard` (today's earnings/calls, rating, recent calls), `GET /me/earnings` (balance, this-month calls/gifts/live subtotals, last-7-days series), `GET /me/earnings/breakdown` (gross by source recomputed pre-commission from each row's own snapshotted rate, commission + an estimated-TDS deduction, net payable), `GET /me/history` (merged calls/gifts/live feed, same "fetch typed lists, merge-sort-slice in application code" pattern `accountDetail.service.ts`'s `getRecentActivity` already used).
- **Gift catalog expanded** — `Gift box`/`Rocket`/`Diamond` added alongside the original Rose/Heart/Crown (seed.ts now upserts by name rather than only seeding an empty table, so this reaches already-seeded environments too) to match the "Ask for a gift" picker. Prices stay real paise, not the mockup's bean numbers — same already-documented reasoning as the admin pass's gift-pricing note.
- **Known issue found, not fixed (pre-existing, unrelated to this pass)**: `live.service.ts`'s `listLiveBroadcasts`/`listLiveBroadcastsForAdmin` do one extra query pair (host lookup + viewer count) per broadcast in a loop — fine at low volume, but with ~60+ broadcasts stuck in `live` status accumulated from repeated local test runs, `GET /live/broadcasts` and `GET /admin/live-broadcasts` took 28-30s in this pass's own verification. Flagged for a future fix (batch the host lookups and viewer counts into one query each) rather than fixed here, since it's unrelated to the Host app gap-closure work and touches a different code path — should go through the `debug-issue` workflow.
- Postman collections split one-per-app (Host/User/Admin design follow-up decision — the single combined `TriloPlan-Backend.postman_collection.json` is retired): `postman/TriloPlan-Host.postman_collection.json` (screen-verified against the Host app's Figma, every endpoint above included), `postman/TriloPlan-User.postman_collection.json` (seeded with what's already built for USER, to be revisited once User app screens are shared), `postman/TriloPlan-Admin.postman_collection.json` (everything under `/admin/*`). All three verified end-to-end with `newman` against a live server: Host 54/54 requests, User 38/38, Admin 58/58, 0 failures across all three.

### User app design follow-up — built

Found by reviewing the User app's Figma designs (~90 screens) screen-by-screen against the built API, same method as the Host/Admin passes. Four things in the Figma directly conflicted with decisions `BRD.md` had already made — each resolved explicitly with the business before building anything, not silently picked either way:

1. **User-facing currency** — the Figma shows the wallet/recharge/call-spend entirely in "beans," but BRD.md is explicit beans are the host's internal earnings unit only. **Resolved: paise stays the real internal unit; "beans" is a display-only label.** `wallet.service.ts`'s `paiseToDisplayBeans` is a fixed, non-configurable constant (1 rupee = 5 display beans) used only for rendering (`GET /wallet`'s `displayBeans`) — never for money movement. Deliberately separate from `recharge_packages.displayBeans` (an admin-set marketing number per package, a volume bonus that doesn't have to reconcile with the flat constant — same idea as withdrawal slabs beating the base beans-earn rate at higher volumes).
2. **VIP Subscriptions** — BRD.md's "Out of scope (this phase)" list explicitly excluded subscription pricing. **Reversed by explicit decision** — see the BRD.md amendment note on that line.
3. **"Level Up" loyalty tiers** (Silver/Gold/Platinum by cumulative recharge) — not in the BRD at all, no tier economics specified anywhere. **Not built** — flagged as a known gap against the Figma, not guessed at.
4. **Age verification** — BR-ACC-04 requires KYC-document-reviewed verification "distinct from a self-declared checkbox," but the Figma's onboarding is an instant self-declared-DOB decision. **Resolved: Users self-declare, Hosts still go through KYC review** — see the BRD.md amendment note on BR-ACC-04.

Everything else below is a straightforward missing-endpoint/missing-field gap, not a new decision.

- **Wallet recharge (new)** — `recharge_packages`/`recharge_txns` tables: this is the `RechargeTxn` table §2 already envisioned but never actually built. `GET /wallet/recharge-packages` (the Talktime screen's preset tiles, admin-configurable catalog same CRUD spirit as `gifts`), `POST /wallet/recharge/initiate` (order creation, §2 step 1), `POST /wallet/recharge/:id/dev-resolve` (stands in for the gateway webhook — no real gateway wired up yet, §3 — same dev-stub convention as withdrawal's payout call). Success calls the already-built `creditUserWallet` with `referenceType: "recharge"`, previously only ever exercised via the blunt `dev-credit` stub.
- **VIP subscriptions (new)** — `vip_plans`/`vip_subscriptions`/`vip_configs`. `GET /vip/plans`, `POST /vip/subscribe` (dev-stubbed payment, extends from the current expiry if already active — standard renewal semantics), `GET /me/subscriptions`, `POST /me/subscriptions/:id/cancel` (`cancelAtPeriodEnd` — benefits continue until `expiresAt`, matching the Active Subscriptions screen's copy). The one real money-path piece: `calls.service.ts`'s `initiateCall` applies the active subscriber's discount (`vip_configs.callDiscountBasisPoints`, a seeded placeholder — no % is specified anywhere in the Figma) to the resolved per-minute rate *before* it's snapshotted onto the call, so commission/host-beans flow through the existing unchanged math on the now-discounted amount — no separate "platform eats the discount" ledger entry, since no economics beyond "discount on all calls" is specified. Scope cut, stated explicitly: "VIP Access/Chats/Care" (unlimited live+chat, priority messages, priority support) aren't wired to anything — chat and live-viewing aren't paywalled today, and there's no support-ticket or chat-priority system to hook a "priority" flag into. Only the discount and `GET /me`'s `isVipActive` flag are real.
- **Self-declared age verification (new)** — `POST /me/verify-age` (`users.service.ts`'s `verifyOwnAge`, User-only), reads `users.dob` (400 if unset), sets `ageVerified=true` if 18+. Never suspends on failure — just leaves `ageVerified` false, nothing more destructive.
- **Host detail endpoint (new — was missing entirely)** — `GET /hosts/:id` (`hosts.service.ts`'s `getHostDetail`): bio, `languages`/`talksAboutTags`/`hobbies`/`sports` (new structured `hostProfiles` columns, alongside the existing free-text `bio`), gallery, rating, follower count, `isFollowing`, online status, derived `age` (from `users.dob`, which itself is never exposed — only the derived number is public). The Creator Profile screen had no backing endpoint before this; only the list view (`GET /hosts`) existed.
- **Host list: search + gallery count** — `hosts.service.ts`'s `listHosts` gained an optional `q` param (partial match on name or any spoken language, via a `unnest()` search over `hostProfiles.languages` — array columns don't support `ILIKE` directly) for the Search screen, and a batched `galleryCount` per host (the small photo-count badge on the Home cards), same "merge into an already-fetched list" pattern ratings/presence already use in that module.
- **Call history (new)** — `GET /me/calls` (`calls.service.ts`'s `listCallsForUser`) — the User app's Past Calls screen; this role ("list my own calls, paginated") previously only existed on the host side (`earnings.service.ts`'s `getHostHistory`).
- **Delete account (new)** — `POST /me/delete-account` (`users.service.ts`'s `deleteOwnAccount`) — soft delete via anonymization (`name`/`email`/`dob`/`username` → null, `phone` → a scrubbed unique placeholder, `status` → new `accountStatusEnum` value `"deleted"`, which reuses the exact same login-blocking check every other non-`"active"` status already gets). Never an actual row deletion — past calls/gifts/ledger entries need a valid owner to keep meaning. Reuses `admin.service.ts`'s `setAccountStatus` token-revocation/socket-disconnect helpers (`revokeAllRefreshTokensForUser`, `disconnectUser`) since the effect is identical to a suspension.
- **Grievance flow (new)** — `grievances` table, `POST /grievances` (`grievance.service.ts`), evidence upload via `POST /grievances/upload-url` (same presign-then-submit flow as KYC documents). The India IT-Rules-style formal complaint form the Terms & Policies screen's "Grievance Officer... response within 15 days" implies — deliberately distinct from `moderation_reports` (different SLA, structured contact fields resubmitted explicitly rather than trusted from the account, fixed complaint-nature taxonomy, file evidence). Scope cut, stated explicitly: no admin review screen for this exists yet (wasn't in the admin app's Figma reviewed earlier) — submission + storage only.
- **Username + user languages** — `users.username` (unique, nullable) and `users.languages` (for "creator recommendations" per the design — no recommendation engine consumes it yet, same "field before the feature" precedent as `hostProfiles.privateLiveRatePerMinutePaise`). `PATCH /me` gained both, with a 409 on a taken username.
- **Notification preferences: three more fields** — `liveAlerts`/`callSummaries`/`walletActivityAlerts` added to the same `notification_preferences` table/endpoints the Host app pass built (already role-agnostic, no new routes needed).
- Postman: `TriloPlan-User.postman_collection.json` updated for every endpoint above.

---

## Open decisions before implementation starts

1. Target region/currency (affects payment gateway choice) — assuming India-first unless told otherwise.
2. ~~Managed CPaaS vs self-hosted video~~ — **decided: Agora** for both 1:1 calls and live broadcasting (§4); ZEGOCLOUD as fallback if pricing doesn't work out. Chat (1:1 and live) is self-built, not vendor-provided.
3. ~~Is 1:1 chat free or charged per-message?~~ — **decided (default): free.** Built free-by-default in Phase 5 since it wasn't resolved in time to block the build; revisit if the business wants it metered. Per-message billing would reuse the exact wallet-debit pattern already used for calls (`wallet.service.ts`), not a new mechanism.
4. Withdrawal cadence/minimum and auto-approval threshold for hosts.
5. Who owns legal/payment-gateway approval for the adult-content angle — this can gate the whole payments build.

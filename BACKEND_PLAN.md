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
- **Not yet real**: the actual gateway Payout/Transfer API call and its webhook. Razorpay payout credentials aren't verified (same blocker as recharge, §2/§3) — `src/lib/payout.ts` dev-stubs the gateway call the same way `src/lib/otpSender.ts` dev-stubs SMS (loud failure in production, logged in dev/test). `POST /withdrawals/:id/dev-resolve-payout` stands in for the missing webhook, and `POST /withdrawals/:id/dev-admin-decision` stands in for the Phase 9 admin approval queue that doesn't exist yet — both are non-prod-only escape hatches, same pattern as `POST /wallet/dev-credit` and `POST /me/kyc/dev-approve`.

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

## 5. Screenshot/recording restriction & 18+ toggle — set expectations correctly

**Screenshot/screen-recording prevention is fundamentally a client-side control; the backend cannot enforce it, only configure and react to it.**
- Android: client sets `FLAG_SECURE` on the sensitive activity/view — this is the actual block, and it's a frontend task.
- iOS: there is **no OS-level API to block screen recording**. The best available is detecting `UIScreen.capturedDidChangeNotification` and reacting (blur the view, end the call) — again frontend-side.
- Backend's role: expose a **per-session/per-content `secure_mode` flag** the client reads and enforces, and provide a `POST /moderation/capture-event` endpoint the client calls when it detects a capture attempt, so you can log it, flag the user, and apply policy (warning → suspension) server-side. Make sure whoever owns the frontend apps knows this split — it's easy to assume "backend will block screenshots" and be wrong.

**18+ toggle**:
- `AdminConfig.adult_mode_enabled` (global, and optionally schedulable/per-broadcast) is straightforward — a feature flag the content APIs check.
- The part that actually needs rigor is **age verification** — a self-declared DOB checkbox isn't defensible; the KYC flow for both users and hosts should capture and verify DOB (ID document check, same pipeline as host KYC) so the 18+ gate has a real basis, not just a checkbox. Store `age_verified` as a distinct boolean from `dob_provided`.

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

- **Fraud**: hosts self-calling from a second account to farm earnings, user/host collusion, chargeback-after-spend abuse — plan for device-fingerprinting and velocity/anomaly rules on top of the ledger, not as an afterthought.
- **Mid-call failure**: network drop mid-tick must never double-charge or leave a call "ongoing" forever — billing ticks and call-end must be idempotent and have a timeout-based reaper job.
- **Horizontal scaling of realtime**: WebSocket/signaling nodes need a shared adapter (Redis) for pub/sub across instances — a single-node assumption breaks the moment you need 2 app servers.
- **RBAC for admin**: separate `SUB_ADMIN` permission sets (finance/withdrawal approval vs moderation vs read-only analytics) rather than one flat admin role, with an audit log of every admin action — this is a money-and-content platform, every privileged action should be attributable.
- **Legal review**: adult content + real-money withdrawal + India-or-wherever jurisdiction is a genuine compliance surface (payment processor terms, data retention, age verification, possibly local licensing) — worth a short legal consult before the payment module is finalized, not after launch.

---

## Open decisions before implementation starts

1. Target region/currency (affects payment gateway choice) — assuming India-first unless told otherwise.
2. ~~Managed CPaaS vs self-hosted video~~ — **decided: Agora** for both 1:1 calls and live broadcasting (§4); ZEGOCLOUD as fallback if pricing doesn't work out. Chat (1:1 and live) is self-built, not vendor-provided.
3. ~~Is 1:1 chat free or charged per-message?~~ — **decided (default): free.** Built free-by-default in Phase 5 since it wasn't resolved in time to block the build; revisit if the business wants it metered. Per-message billing would reuse the exact wallet-debit pattern already used for calls (`wallet.service.ts`), not a new mechanism.
4. Withdrawal cadence/minimum and auto-approval threshold for hosts.
5. Who owns legal/payment-gateway approval for the adult-content angle — this can gate the whole payments build.

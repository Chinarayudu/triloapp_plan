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

### Gifting & gift-requests

- Gifts are a catalog (`Gift{name, price, active}`) priced in real currency, managed by admin — same principle as the wallet: the user picks a gift priced in ₹, not in an abstract unit.
- Sending a gift = same debit(currency)/commission/credit(beans) pattern as billing, tagged `reference_type=GIFT`, works identically whether in a 1:1 call, chat, or live broadcast.
- "Ask for gift" is just a targeted real-time event (socket + push) from host → user with an optional suggested gift; it doesn't move money itself, it just prompts the user's client to open the gift picker.

### Withdrawals

- `WithdrawalRequest{host_id, beans, converted_amount, status}` — `PENDING → APPROVED → PROCESSING → PAID` or `REJECTED`.
- `converted_amount` is computed via the **withdrawal slab table** active at request time (see `WithdrawalSlab` in §6) — not the same rate used when beans were earned; this is where admin controls the actual payout economics.
- Require KYC-verified payout details before a request can be created.
- Minimum withdrawal amount + frequency cap (e.g. once/week) to control payout processing cost and fraud exposure.
- Auto-approve under an admin-set threshold, manual queue above it.
- Actual payout via the payment gateway's payout/transfer API — don't hand-roll bank transfers.

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

### Video/audio calls (1:1)
- Build vs buy is the key call here:
  - **Managed CPaaS** (Agora, ZEGOCLOUD, 100ms, Twilio Video) — much faster to launch, they handle SFU scaling/TURN/recording/global edge, cost is per-minute usage. Recommended for MVP given everything else (payments, moderation, admin) is already a lot of surface area.
  - **Self-hosted SFU** (LiveKit OSS, mediasoup) + coturn for TURN — cheaper at real scale, but you own scaling, recording pipeline, and global reach. Revisit once call-minute volume justifies the ops cost.
- Either way, your backend owns **signaling and business logic**, not media: call state machine (`REQUESTED → RINGING → ACCEPTED → ONGOING → COMPLETED/REJECTED/MISSED/FAILED`), ringing/timeout, billing hooks on connect/disconnect events from the video SDK's server callbacks.

### Live broadcasting (one host → many viewers)
- Needs a many-to-one fan-out, not P2P: RTMP ingest → HLS/LL-HLS distribution, or the live-streaming mode of whichever CPaaS you pick for calls (most offer both 1:1 and live/broadcast products under one SDK — worth keeping both on the same vendor to avoid double integration work).
- Backend tracks `LiveBroadcast` (status, start/end, peak viewers) and `LiveViewer` (join/leave), and reuses the exact same gifting pipeline for in-broadcast gifts.
- Live chat is a separate high-throughput fan-out channel (Redis pub/sub or the video vendor's built-in chat) — needs rate-limiting/spam control since it's public.

### Presence
- Redis-backed online/available/busy/offline state per host, pushed to user app via WebSocket/pub-sub so the host list updates live without polling.
- Host list API: filter by available, sort by rating/price/recently-online, paginate.

### Chat (1:1)
- Persisted message history (Postgres is fine at this scale; move to a dedicated store only if volume demands it), delivered live over WebSocket, push notification when recipient is offline.
- Decide up front whether messages are free or charged — affects the schema (needs a billing hook per message if metered, same currency-debit/bean-credit pattern as calls and gifts).

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
2. Managed CPaaS vs self-hosted video (Agora/100ms/ZEGOCLOUD vs LiveKit/mediasoup) — recommend managed for MVP.
3. Is 1:1 chat free or charged per-message?
4. Withdrawal cadence/minimum and auto-approval threshold for hosts.
5. Who owns legal/payment-gateway approval for the adult-content angle — this can gate the whole payments build.

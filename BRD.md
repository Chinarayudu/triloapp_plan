# Business Requirements Document (BRD)
## Video Chat & Live Broadcasting Platform — Backend

| | |
|---|---|
| **Document owner** | Backend team |
| **Status** | Draft v1 |
| **Date** | 2026-08-03 |
| **Related docs** | [`BACKEND_PLAN.md`](BACKEND_PLAN.md) (technical architecture), [`tech-stack/TECH_STACK.md`](tech-stack/TECH_STACK.md) (stack), [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) (phases/timeline) |

This document states **what the business needs the system to do and why**. It intentionally avoids implementation detail (schema, APIs, package choices) — those live in the linked technical docs. Each requirement below is numbered so it can be traced forward into the technical plan and backward into a test case.

---

## 1. Purpose & executive summary

The business is building a three-sided platform connecting **paying users** with **hosts** who monetize their time via per-minute video calls, live broadcasts, chat, and gifts. The platform takes a commission on every monetized interaction. This document defines the business requirements for the **backend system** that powers three separately-built frontend applications: a User app, a Host app, and an Admin app.

The core business mechanic: a user recharges real money into a wallet, spends it on a per-minute basis talking to a host of their choosing (or via gifts/live broadcasts), the platform retains a commission, and the host's net earning is credited as an internal unit ("beans") that they later convert to real payout.

---

## 2. Business objectives

- **BO-1**: Enable users to pay for time-based access to hosts (video calls) with transparent, real-currency pricing — no confusing internal currency on the paying side.
- **BO-2**: Enable hosts to earn from their time (calls), attention (live broadcasts), and audience goodwill (gifts), and withdraw those earnings reliably.
- **BO-3**: Guarantee the platform's commission is captured on every monetized interaction, with no path for money to move between a user and a host without commission being applied.
- **BO-4**: Give the admin/business team full operational control over pricing, commission, payout economics, and content policy — without needing a code deployment to change a number.
- **BO-5**: Operate within the legal/compliance envelope required for a platform that includes an admin-togglable 18+ content mode and real-money withdrawal.

---

## 3. Scope

### In scope (this build)
- User, Host, and Admin/Sub-admin account management, including KYC.
- Wallet recharge (real money → user balance) via payment gateway.
- Per-minute video calling between a user and a host, server-billed.
- Commission capture on calls, gifts, and live-broadcast monetization.
- Host earnings ("beans"), withdrawal request workflow, and payout.
- Live broadcasting (one host, many viewers) with in-broadcast chat and gifting.
- 1:1 text chat between user and host.
- Gifting, including host-initiated "gift request" prompts.
- Admin-configurable 18+ content mode and age-gating.
- Screenshot/recording policy enforcement hooks (frontend-enforced, backend-configured/logged — see §7).
- Admin moderation queue, KYC approval, pricing/commission/payout configuration, analytics dashboards, RBAC for sub-admins.
- Push notifications for calls, gifts, low balance, withdrawal status, host going live.

### Out of scope (this phase — candidates for later)
- The three frontend applications themselves (built by a separate team).
- In-house payment processing (a licensed gateway is used, not built).
- Automated AI content moderation of live video (manual/report-based moderation only, for now).
- Multi-currency/multi-region pricing (single-currency assumed initially — see Assumptions).
- Subscription/membership pricing tiers (pure pay-per-use only, for now).

---

## 4. Stakeholders

| Role | Interest |
|---|---|
| Business owner / Admin team | Commission revenue, pricing/policy control, compliance |
| Users | Fair, transparent per-minute pricing; reliable calls; safe payment |
| Hosts | Accurate, timely earnings; reliable withdrawal; safety tools (block/report) |
| Frontend teams (User, Host, Admin apps) | Stable API contracts, predictable release phases (see `DEVELOPMENT_ROADMAP.md`) |
| Payment gateway / video CPaaS vendors | Compliant integration, accurate webhook handling |
| Legal/compliance | Age verification integrity, payment processor ToS adherence, data handling |

---

## 5. Business requirements

Each requirement is labeled `BR-<module>-<num>` for traceability.

### 5.1 Account management & KYC

- **BR-ACC-01**: The system shall support three distinct roles — User, Host, Admin (with sub-admin permission tiers) — with role-appropriate access to functionality.
- **BR-ACC-02**: Users and Hosts shall authenticate via phone number (OTP), not username/password, to minimize account-sharing/fraud friction.
- **BR-ACC-03**: Hosts shall complete KYC (identity document + payout account details) before being allowed to go online/available or request a withdrawal.
- **BR-ACC-04**: The system shall capture and verify date of birth as part of KYC for both Users and Hosts, distinct from a self-declared checkbox, to support defensible age-gating (see BR-MOD-02).
- **BR-ACC-05**: Admin shall be able to suspend or ban any User or Host account, with the suspension taking effect immediately (in-progress sessions terminated, not just blocked from new logins).

### 5.2 Wallet & recharge

- **BR-WAL-01**: Users shall recharge their wallet with real money via an integrated payment gateway; the wallet balance shall reflect the exact amount recharged (no hidden conversion or internal unit on the user side).
- **BR-WAL-02**: A recharge shall only be considered successful, and the wallet only credited, based on a server-verified confirmation from the payment gateway — never on a client-reported "payment successful" signal alone.
- **BR-WAL-03**: Every wallet balance change shall be individually recorded and auditable (who/what/when/why), not just reflected as a single running balance number.
- **BR-WAL-04**: The system shall reconcile wallet credits against the payment gateway's own transaction records on a recurring basis, to catch and correct any missed confirmation automatically.

### 5.3 Host discovery & availability

- **BR-DIS-01**: Hosts shall be able to set themselves online/available or offline/busy in real time, and this status shall be visible to Users within a short, defined delay (target: under a few seconds).
- **BR-DIS-02**: Users shall see a list of currently available hosts, each showing their per-minute rate, and shall be able to filter/sort that list (e.g., by availability, price, rating).
- **BR-DIS-03**: Each host's per-minute rate shall be set by the host (within any bounds Admin chooses to enforce) and shall be clearly shown to the User before a call begins.

### 5.4 Video calling & billing

- **BR-CALL-01**: A call between a User and a Host shall only be allowed to start if the User's wallet balance can cover at least a minimum buffer of call time at the Host's stated rate.
- **BR-CALL-02**: The User shall be billed per minute (or finer-grained interval) of actual connected call time, at the Host's rate, for the duration of the call — call duration shall be determined by the server, not the client app.
- **BR-CALL-03**: The system shall warn the User when their remaining balance is close to running out, and shall end the call gracefully (not abruptly mid-charge) when the balance is exhausted.
- **BR-CALL-04**: If a call ends unexpectedly (network drop, app crash), the User shall be billed only for time actually connected, and the system shall not leave a call in a permanently "ongoing" state.
- **BR-CALL-05**: Every call's final billed amount, commission taken, and host earning shall be individually retrievable for dispute resolution (by Admin) and for the User's/Host's own history view.

### 5.5 Commission

- **BR-COM-01**: The platform shall retain a configurable commission percentage on every call, gift, and live-broadcast-gift transaction.
- **BR-COM-02**: Admin shall be able to change the commission percentage without a deployment, and any change shall apply only to transactions occurring after the change — transactions already completed or in progress shall retain the rate that was active at the time.
- **BR-COM-03**: Commission rate shall be configurable globally and, if the business chooses, per individual host (e.g., for negotiated rates with top earners).

### 5.6 Host earnings & withdrawal

- **BR-EARN-01**: A host's net earning (post-commission) from a call, gift, or live-broadcast interaction shall be credited to their earnings balance ("beans"), not as direct real-money credit.
- **BR-EARN-02**: Hosts shall be able to request withdrawal of their earnings balance, converted to real currency at an Admin-configured rate, which may be tiered ("slabs" — e.g., better rates at higher withdrawal volumes).
- **BR-EARN-03**: A withdrawal request shall require the host to have completed KYC with valid payout details on file.
- **BR-EARN-04**: The system shall enforce an Admin-configured minimum withdrawal amount and a maximum withdrawal frequency (e.g., no more than once per week) per host.
- **BR-EARN-05**: Withdrawal requests below an Admin-configured threshold shall be automatically approved and processed; requests above it shall queue for manual Admin approval.
- **BR-EARN-06**: If a payout fails after approval, the withdrawn amount shall be returned to the host's earnings balance, not lost.

### 5.7 Live broadcasting

- **BR-LIVE-01**: A host shall be able to start a live broadcast visible to multiple simultaneous viewers.
- **BR-LIVE-02**: Viewers of a live broadcast shall be able to send messages in a live chat visible to all viewers of that broadcast.
- **BR-LIVE-03**: Viewers shall be able to send gifts during a live broadcast using the same gifting and commission mechanism as 1:1 interactions.
- **BR-LIVE-04**: The system shall track concurrent and peak viewer counts per broadcast for the host's and Admin's visibility.

### 5.8 Chat

- **BR-CHAT-01**: Users and Hosts shall be able to exchange 1:1 text messages, with message history persisted and retrievable.
- **BR-CHAT-02**: A message shall be delivered in real time when the recipient is active in the app, and via push notification when they are not.
- **BR-CHAT-03**: Whether chat messages are free or charged shall be an Admin-configurable business decision (open item — see `DEVELOPMENT_ROADMAP.md`).

### 5.9 Gifting

- **BR-GIFT-01**: Admin shall maintain a catalog of purchasable gifts, each with a real-currency price and an active/inactive state.
- **BR-GIFT-02**: Sending a gift shall debit the sender's wallet, apply commission, and credit the recipient host's earnings balance, identically whether sent during a call, in chat, or during a live broadcast.
- **BR-GIFT-03**: A host shall be able to send a "gift request" prompt to a user (during a call or chat), which the user may accept or dismiss; the prompt itself shall not move any money until/unless the user acts on it.

### 5.10 Content moderation & restrictions

- **BR-MOD-01**: Admin shall be able to enable or disable an "18+ content mode" for the platform (globally, and/or scoped to specific broadcasts/content) without requiring a deployment.
- **BR-MOD-02**: When 18+ mode is enabled, only age-verified accounts (per BR-ACC-04) shall be able to access the affected content.
- **BR-MOD-03**: The system shall provide a mechanism for the app to signal that screen capture/recording should be blocked for a given session, and shall log any reported capture attempt for policy action (warning, suspension). It is understood that the actual technical blocking of screenshots/recording is a frontend/OS-level capability with platform limitations (particularly on iOS) — this is a policy-and-logging requirement on the backend, not a guarantee of prevention.
- **BR-MOD-04**: Users and Hosts shall be able to report another user/host or a piece of content; reports shall enter an Admin moderation queue.
- **BR-MOD-05**: Admin shall be able to suspend/ban an account as a result of a moderation action, consistent with BR-ACC-05.

### 5.11 Admin & platform management

- **BR-ADM-01**: Admin shall have a dashboard view of key business metrics: revenue, active users/hosts, call minutes, commission collected, top earners.
- **BR-ADM-02**: Admin shall be able to manage all pricing/economics levers without a deployment: commission %, beans earn-rate, withdrawal slabs, gift catalog and prices, withdrawal thresholds.
- **BR-ADM-03**: Admin functionality shall support sub-admin roles with restricted permission sets (e.g., a finance-only role that can approve withdrawals but not moderate content, and vice versa).
- **BR-ADM-04**: Every administrative action that changes money-affecting configuration or account status shall be logged with who made the change and when, and shall be reviewable later.
- **BR-ADM-05**: Admin shall be able to review and approve/reject host KYC submissions and withdrawal requests queued above auto-approval thresholds.

### 5.12 Notifications

- **BR-NOTIF-01**: The system shall push real-time notifications for: incoming call, gift received, low wallet balance, withdrawal status change, and a followed/favorite host going live.

---

## 6. Non-functional requirements

- **NFR-1 (Financial integrity)**: No system failure (crash, network drop, retried request) shall result in a User being charged without a corresponding service rendered, or a Host's earning being lost or duplicated. This is the single highest-priority non-functional requirement in the system.
- **NFR-2 (Real-time responsiveness)**: Host availability changes, incoming call signaling, and chat delivery shall feel instantaneous to end users — target sub-second to low-second latency for these events.
- **NFR-3 (Availability)**: The platform is a real-time, money-handling service; downtime directly stops revenue and blocks host earnings — target a high-availability posture (specific SLA to be set with the business, e.g. 99.9%).
- **NFR-4 (Scalability)**: The system shall support growth in concurrent calls and concurrent live-broadcast viewers without requiring architectural rework — horizontal scalability is a day-one design constraint, not a later optimization.
- **NFR-5 (Security)**: No raw payment card data shall be handled or stored by the platform directly (handled entirely by the payment gateway's hosted flow). All financial and KYC data shall be encrypted at rest and in transit.
- **NFR-6 (Auditability)**: Every financial transaction and every privileged admin action shall be individually traceable, in support of dispute resolution and regulatory inquiry.
- **NFR-7 (Data privacy)**: KYC documents, chat content, and call metadata shall be handled per applicable data protection requirements for the platform's operating jurisdiction(s).

---

## 7. Assumptions

- Single currency/region at launch (assumed India-first per prior discussion) — multi-region is a future consideration, not in this phase's scope.
- The three frontend applications are built and maintained by a separate team; this backend exposes APIs/contracts they consume (see `DEVELOPMENT_ROADMAP.md` §0 for the collaboration model).
- A managed payment gateway and a managed video/live-streaming CPaaS will be used rather than either being built in-house (see `BACKEND_PLAN.md` §3–4 for the reasoning).
- Screenshot/screen-recording prevention is understood by all stakeholders to be a best-effort, frontend/OS-enforced control, not a backend guarantee (see BR-MOD-03).
- Age verification relies on the KYC identity-document process; there is no fully-automated, foolproof age verification available at reasonable cost — the business accepts this as the industry-standard approach.

## 8. Constraints

- Adult-content-adjacent monetization significantly narrows the pool of usable payment gateways to high-risk-tier processors, which may have longer onboarding and different fee structures than mainstream gateways (see `BACKEND_PLAN.md` §3).
- Real-money withdrawal to hosts introduces KYC/AML-adjacent obligations that constrain how quickly a host can be onboarded to full earning/withdrawal capability.
- The backend is being built by a single developer initially (see `DEVELOPMENT_ROADMAP.md`), which bounds how many phases can run in true parallel.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Payment gateway rejects or later freezes the merchant account over adult-content policy | Apply specifically as high-risk merchant category upfront; keep a fallback gateway integration path in the architecture rather than hard-coding one vendor |
| Billing bug causes user overcharge or host underpayment | Server-authoritative billing, double-entry ledger, nightly reconciliation, heavy test focus on the calls/billing phase (`DEVELOPMENT_ROADMAP.md` Phase 4) |
| Self-dealing fraud (host and user accounts colluding, or a host self-calling a second account) | Device-fingerprinting and velocity/anomaly rules, flagged as a Phase 11 hardening item |
| Age-verification gap leads to compliance exposure on 18+ content | KYC-backed `age_verified` flag, not a self-declared checkbox; legal review before 18+ mode is enabled in production |
| Frontend teams blocked waiting on backend delivery | Contract-first development model — mock APIs published before implementation, per `DEVELOPMENT_ROADMAP.md` §0 |

## 10. Success metrics (indicative — confirm targets with business)

- Recharge success rate (gateway confirmation vs initiated) above a defined threshold.
- Call billing accuracy: zero unreconciled discrepancy between ledger sum and wallet balance in nightly reconciliation.
- Withdrawal turnaround time from request to payout, within the Admin-configured SLA.
- Host retention/earnings growth month over month.
- Moderation report response time (report submitted → Admin action taken).

## 11. Dependencies

- Payment gateway account approval (external, business-side).
- Video/live-streaming CPaaS vendor account and pricing agreement (external).
- Legal/compliance sign-off on 18+ mode and age-verification approach before production enablement.
- Frontend teams' consumption of the shared API contract (see `DEVELOPMENT_ROADMAP.md`).

## 12. Glossary

- **Beans** — internal unit representing a host's earnings balance, converted to real currency at withdrawal.
- **Commission** — the platform's percentage cut of every monetized interaction (call, gift, live gift).
- **CPaaS** — Communications Platform as a Service; a managed vendor providing video/voice/live-streaming infrastructure.
- **Host** — the platform's monetized participant (referred to as "girl" in early business discussion); the party being paid for time/attention.
- **KYC** — Know Your Customer; identity verification process.
- **Ledger** — the immutable, append-only record of every financial movement in the system.
- **Withdrawal slab** — a tiered conversion rate applied to beans at withdrawal time, which may improve at higher volumes.

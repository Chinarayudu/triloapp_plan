# UX Screens & Flows — Frontend / Figma Brief

**This is the document to hand to whoever is designing screens in Figma.** It lists every screen each of the three apps needs, what's on it, and the flows connecting them — deliberately free of backend/API detail. For *why* a feature exists, see [`BRD.md`](BRD.md); for *how* the backend implements it, see [`BACKEND_PLAN.md`](BACKEND_PLAN.md); for *when* each piece lands, see [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md).

Three apps, three sections below, plus shared elements every app needs.

---

## 0. Shared across all three apps

- **Splash → Login** — phone number entry → OTP entry → routed to the right app's home based on role.
- **Profile setup** (first login only) — name, photo, DOB (feeds age verification), for Users and Hosts.
- **Notifications center** — list of past notifications (call, gift, low balance, withdrawal status, etc.), tap-through to the relevant screen.
- **Standard states every screen needs a design for**: loading, empty ("no hosts online right now", "no messages yet"), error/retry, offline/no-connectivity, session-expired → re-login.
- **18+ interstitial** — a one-time (or per-session) consent/age-confirmation screen shown when 18+ mode is active and the account is entering age-gated content, distinct from the KYC-based verification itself.
- **Screenshot/recording-blocked notice** — a screen/toast shown when the app detects (or preemptively blocks) a capture attempt on a secure screen (e.g., during a call). This is enforced by the frontend, but still needs a designed state.

---

## 1. User App (the paying customer)

### Screens

1. **Onboarding / Login** — phone + OTP.
2. **Home / Discover hosts** — list/grid of available hosts: photo, name, online/available badge, per-minute rate, rating, search + filter/sort (price, rating, recently online).
3. **Host profile** — bio, photo gallery, per-minute rate, rating/reviews, live status, primary actions: Call / Chat / Gift.
4. **Wallet** — current balance (shown as real currency, not an internal unit), "Add money" button, recent transaction list.
5. **Recharge screen** — amount picker (preset amounts + custom), hands off to the payment gateway's checkout UI, success/failure confirmation screen.
6. **Video call — ringing/connecting** — host photo, "Calling…" state, cancel button.
7. **Video call — ongoing** — video feed, call timer, **running cost so far** (real-time), low-balance warning banner, end-call button, in-call chat toggle, in-call gift button.
8. **Call ended / summary** — duration, amount charged, "rate this call" prompt, "chat with host" / "call again" shortcuts.
9. **Chat list** — recent conversations with hosts, unread indicators.
10. **Chat conversation** — message thread with a specific host, gift button inline, "host is live" banner if applicable.
11. **Gift picker** — grid/catalog of gifts with price and icon, confirm-send step; a separate **"host requested a gift" popup/modal** that can appear over a call or chat screen with accept/dismiss.
12. **Live broadcasts discovery** — list/grid of currently live hosts with viewer counts.
13. **Live broadcast viewer** — video stream, live chat panel alongside it, viewer count, gift button, leave button.
14. **Call & transaction history** — past calls (duration, cost) and past recharges/gifts, one combined or two separate screens.
15. **Report / block** — modal reachable from a host profile, call, or chat: reason selection, submit.
16. **Profile & settings** — edit profile, blocked list, notification preferences, help/support, logout.

### Key flows to storyboard

- **Recharge**: Wallet → tap Add Money → pick amount → gateway checkout → success screen → updated balance on Wallet.
- **Make a call**: Home → pick host → Host profile → tap Call → (balance check) → Ringing → Ongoing (live cost ticking) → low-balance warning (if applicable) → auto or manual end → Summary.
- **Send a gift**: from Host profile, Chat, in-call, or Live viewer screen → Gift picker → confirm → sent confirmation (same entry point, four contexts — design it once, reuse everywhere).
- **Receive a gift request**: popup appears over whatever screen the user is on → Accept (goes to Gift picker pre-filtered/pre-selected) or Dismiss.
- **Join a live broadcast**: Live discovery → tap a live host → Viewer screen → chat/gift inline → Leave.
- **Low balance mid-call**: warning banner appears in Ongoing call screen → if balance hits zero, call ends automatically → Summary screen shows why it ended, with a shortcut straight to Recharge.

---

## 2. Host App (the earner — referred to as the "girl" app in early discussion)

### Screens

1. **Onboarding / Login** — phone + OTP.
2. **KYC submission** — ID document upload, DOB, payout account details (bank/UPI).
3. **KYC pending / status screen** — "under review" state, and a rejected state with reason + resubmit action.
4. **Home dashboard** — online/offline availability toggle (prominent — this is the host's main daily control), quick stats (today's earnings, recent activity), incoming-call handling.
5. **Incoming call screen** — caller info (or anonymized, per business decision), Accept / Reject.
6. **Video call — ongoing** — video feed, call timer, **live earnings ticking up** (in beans), end-call, in-call chat toggle, **"ask for a gift" button** (triggers the popup on the user's side).
7. **Call ended / summary** — duration, beans earned from that call.
8. **Chat list** and **chat conversation** — same shape as the User app's, mirrored.
9. **Go Live — setup** — pre-broadcast screen (title/thumbnail if applicable), "Start" button.
10. **Live broadcasting (host's own view)** — self-view + viewer count + incoming live chat + incoming gifts feed, "End broadcast" button.
11. **Earnings dashboard** — beans balance, breakdown by source (calls/gifts/live), historical earnings chart, statement/export.
12. **Withdrawal screen** — request form (amount in beans → converted amount shown using current slab), minimum-amount and frequency-limit messaging, request history with status (pending/approved/processing/paid/rejected).
13. **Profile & rate settings** — bio, gallery upload, set per-minute rate (within any admin-enforced bounds).
14. **Report / block a user** — same pattern as the User app's, mirrored.
15. **Notifications center** and **Settings** (payout details, logout, help/support) — mirrored from shared/User-app patterns.

### Key flows to storyboard

- **Onboarding to earning-ready**: Login → Profile setup → KYC submission → Pending screen → (approval) → Home dashboard unlocked, availability toggle enabled.
- **Go online → get a call → earn**: Home (toggle online) → Incoming call → Accept → Ongoing call (earnings ticking) → call ends → Summary → Earnings dashboard updated.
- **Ask for a gift**: tap "ask for gift" during a call/chat → (nothing changes on host's screen except a sent-confirmation) → later, a gift-received notification/animation if the user accepts.
- **Go live**: Home → Go Live setup → Live broadcasting screen (self-view, chat, gifts) → End broadcast → summary of viewers/gifts received.
- **Withdraw earnings**: Earnings dashboard → Withdraw → amount entry (shows live slab conversion) → confirm → status tracker screen → (later) paid confirmation/notification.

---

## 3. Admin App

### Screens

1. **Admin login** — email/password (+ 2FA if the business wants it), distinct from the OTP-based flow used by Users/Hosts.
2. **Dashboard / analytics** — revenue, active users/hosts, total call minutes, commission collected, top-earning hosts, basic charts/time-series.
3. **User management** — searchable list, individual profile view, suspend/ban action.
4. **Host management** — searchable list, individual profile view, suspend/ban action.
5. **KYC review queue** — list of pending submissions, detail view with document viewer, Approve / Reject (with reason) actions.
6. **Withdrawal approval queue** — list of pending requests above auto-approval threshold, detail view, Approve / Reject.
7. **Pricing & economics config** — commission % (global and per-host override), beans earn-rate, withdrawal slabs table, gift catalog CRUD (name/icon/price/active toggle), minimum withdrawal amount, auto-approval threshold.
8. **Moderation queue** — reported users/content, detail view, action buttons (dismiss / warn / suspend / ban).
9. **18+ mode control** — a simple on/off toggle screen (plus scheduling controls, if the business wants time-boxed enablement).
10. **Sub-admin & roles management** — create a sub-admin account, assign a permission set (e.g., finance-only, moderation-only, read-only analytics).
11. **Audit log viewer** — searchable/filterable log of every privileged admin action (who, what, when).
12. **Live broadcasts monitor** — list of currently active broadcasts with viewer counts, ability to force-end one.
13. **Broadcast messaging tool** — compose and send a push notification/announcement to all users or a segment.

### Key flows to storyboard

- **KYC approval**: KYC queue → open submission → view documents → Approve (host unlocked) or Reject (host notified, can resubmit).
- **Withdrawal approval**: Withdrawal queue → open request → verify → Approve (triggers payout) or Reject (beans returned to host).
- **Change a pricing lever**: Pricing config → edit commission % or a slab → save → (this should visibly *not* retroactively affect the analytics for already-completed transactions — worth designing a small "effective from now" confirmation state so admins understand this).
- **Moderation action**: Moderation queue → open report → review → choose action → confirmation, with the action landing in the audit log.
- **Create a sub-admin**: Sub-admin management → new → assign permission set → invite sent.

---

## 4. Roles → app → screen-access matrix

| | User App | Host App | Admin App |
|---|---|---|---|
| **User** | full access | — | — |
| **Host** | — | full access | — |
| **Admin (super)** | — | — | full access |
| **Sub-admin (finance)** | — | — | withdrawal queue, pricing config, dashboard — not moderation |
| **Sub-admin (moderation)** | — | — | moderation queue, user/host management, KYC — not pricing |

Use this to decide which admin screens need a permission-gated empty/locked state in the Figma file, since a sub-admin will see the same app shell with sections hidden or disabled depending on their assigned role.

---

## 5. Design-system notes worth deciding before screens are built

- **Money display convention**: User-facing balances/prices are always real currency (₹X) — never show "coins" anywhere in the User app. Host-facing earnings are in beans, with the real-currency equivalent shown as a secondary/converted figure where helpful (e.g., on the withdrawal screen).
- **Live/real-time indicators need a consistent visual language**: presence dot (online/busy/offline), live call cost ticking upward, live viewer count, live earnings ticking upward — these should look and feel like one family of "live number" components, not four different treatments.
- **18+ visual treatment**: decide once (blur/age-gate overlay, badge, or separate section) and apply consistently everywhere age-gated content can appear (host list, host profile, live discovery).
- **Empty/error/offline states** should be designed once per pattern and reused, not bespoke per screen — there are a lot of lists in this product (hosts, chats, transactions, withdrawals, moderation queue) and they should feel like one system.

---

## 6. What this document deliberately leaves out

- Exact API request/response shapes, field names, data types — that's `BACKEND_PLAN.md` and the OpenAPI contract described in `DEVELOPMENT_ROADMAP.md` §0, which the frontend engineers (not the Figma designer) will need once screens move into build.
- Pricing/commission logic and business rules — that's `BRD.md`.
- Delivery order and timing — that's `DEVELOPMENT_ROADMAP.md`.

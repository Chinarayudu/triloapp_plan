# Bug History

Log of every bug fixed in this backend, most recent first. Checked at the start of every debugging session (see [`.claude/skills/debug-issue/debug.md`](.claude/skills/debug-issue/debug.md), Step 2) — if a newly-reported issue matches an entry's signature here, apply the documented fix directly instead of re-deriving it from scratch (after confirming the surrounding code hasn't changed in a way that invalidates it).

## Entry template

Copy this for each new entry, filled in, added to the top of the log below.

```
### [YYYY-MM-DD] <short title>

**Symptom**: <error message / observed behavior, verbatim where possible>
**Root cause**: <what was actually wrong, one or two sentences>
**Affected files**: <list of files changed>
**Fix**: <what changed, and why this was the minimal correct fix>
**Call sites checked**: <every other usage of the affected code that was verified not to regress>
```

---

## Log

### [2026-09-20] KYC selfie video upload rejected — "Invalid option: expected one of \"image/jpeg\"|\"image/png\"|\"application/pdf\""

**Symptom**: `POST /me/kyc/upload-url` returns `400` with that Zod `invalid_enum_value` message when the Host app's selfie liveness step tries to get a presigned upload URL, sending `contentType: "video/webm;codecs=vp9,opus"`.
**Root cause**: the endpoint's content-type allowlist only ever covered still images/PDF. Separately, the Host app's selfie step now records a short liveness video via the browser's `MediaRecorder`, which reports `contentType` as the base MIME type plus a `;codecs=...` parameter that varies by browser/OS (`vp9,opus` on Chrome/Android, `vp8,opus` on Firefox, etc.) — so even adding `"video/webm"` to a `z.enum` exact-match wouldn't reliably work, since the codec suffix isn't fixed.
**Affected files**: `src/modules/users/users.routes.ts` (`EXTENSION_BY_CONTENT_TYPE`, `uploadUrlSchema`, `POST /me/kyc/upload-url`), `src/modules/users/kyc.test.ts` (new regression test).
**Fix**: added `"video/webm": "webm"` to the allowlist, and changed validation/extension-lookup to match on the base type (the part before the first `;`) rather than the full string — any codec combination for `video/webm` now passes. The full original string (codecs included) is still what's sent to S3 as the object's `Content-Type`, since that's a legal HTTP media-type parameter.
**Call sites checked**: `GALLERY_EXTENSION_BY_CONTENT_TYPE` (gallery upload route) — separate map, untouched. `POST /me/kyc` (submit step) — takes `documentType` + `key` only, no content-type validation, so no schema/enum change needed there for "selfie" to mean a video artifact. Existing `application/pdf` tests (`kyc.test.ts`, `withdrawal.test.ts`) and the `text/plain` → `400` rejection test all still pass unchanged. Full suite (137/137, including the new codec-qualified-webm test) and `tsc --noEmit` pass.
**Known follow-up, not yet needed**: `video/mp4` isn't allowlisted — Safari/iOS's `MediaRecorder` doesn't produce webm, so an iOS host hitting this same step would 400 the same way. Same fix shape if/when that's reported.

### [2026-09-17] Host permanently can't start a new live broadcast — "You already have a live broadcast running"

**Symptom**: `POST /live/broadcasts` returns `409 "You already have a live broadcast running"` even though the host isn't actually broadcasting anything right now — every retry fails the same way, indefinitely.
**Root cause**: same shape as the 2026-09-16 presence bug below — `live_broadcasts.status` was only ever cleared by an explicit `POST /live/broadcasts/:id/end`. Nothing corrected it when the host's connection dropped mid-broadcast without hitting that endpoint first (crash, closed tab, network loss; that day's Agora-chunk-load and remote-audio bugs were both plausible triggers). `startBroadcast`'s "already live?" check (`getActiveBroadcastForHost`) just reads that stale DB flag, so once stuck, every future start attempt 409s forever — the only escape before this fix was an admin's force-end.
**Affected files**: `src/modules/live/live.service.ts` (new exported `endActiveBroadcastForHostIfAny`), `src/realtime/socket.ts` (fix — new exported `checkAbandonedBroadcast`), `src/config/env.ts` (new `LIVE_BROADCAST_DISCONNECT_GRACE_MS`), `vitest.config.ts` (test override), `src/modules/live/live.socket.test.ts` (new regression tests).
**Fix**: on a socket's `disconnect`, after a grace period (`LIVE_BROADCAST_DISCONNECT_GRACE_MS`, default 15s) with no reconnect, `checkAbandonedBroadcast` auto-ends that host's active broadcast (if any) and fans out `live:ended` to the room, same as a real end. Deliberately *not* instant like the presence fix — ending a broadcast kicks every active viewer, so a quick reconnect (page reload, brief network blip) gets a chance to land first; a status-flag flicker doesn't carry the same cost.
**Call sites checked**: `getActiveBroadcastForHost`/`endBroadcastById` (`live.service.ts`) — both already-existing private helpers, only new caller is `endActiveBroadcastForHostIfAny` itself. Full suite (129/129, including the two new tests) and `tsc --noEmit` pass.
**General lesson**: this is the same lesson as the entry below, generalized — check any OTHER "explicit action sets it, nothing clears it automatically" flag in this codebase (there were two in two days) before assuming a given one is the last.

### [2026-09-16] Host never receives an incoming call — rings out with no visible error on either side

**Symptom**: User calls a host who is shown as online; the call is accepted by the backend (no error to the caller) but the host's app never shows anything — no incoming-call screen, no notification. The call eventually times out/misses.
**Root cause**: `presence.store.ts`'s online flag was only ever set/cleared by the explicit `PATCH /me/presence` toggle. Nothing corrected it when a host's live connection dropped without them toggling offline first (closed tab, backgrounded app, network loss, dev-server hot reload during testing). `initiateCall`'s `isOnline()` gate kept passing for a host who was actually unreachable; `emitToUser` (`realtime/socket.ts`) silently reaches no one when there's no live socket in that user's room; and the push-notification fallback (`lib/push.ts`) is a dev-mode log line only, not a real delivery mechanism — so the ring had no visible failure anywhere.
**Affected files**: `src/realtime/socket.ts` (fix), `src/modules/hosts/presence.store.ts` (unchanged, just read/written from a new call site), `src/modules/hosts/presence.socket.test.ts` (new regression test).
**Fix**: On a socket's `disconnect`, if that account has no other live connection remaining, it's now auto-marked offline and `presence:update` broadcasts the change — the same effect as the explicit toggle. `initiateCall` then fails fast and honestly with `409 "Host is not online"` instead of creating a call that can never be delivered.
**Call sites checked**: `isOnline`/`setOffline` (`presence.store.ts`) — only other caller is `hosts.routes.ts`'s `PATCH /me/presence` handler, unaffected. `broadcastPresence` — same single existing caller plus this new one, same event/payload shape. Full suite (127/127, including the new disconnect-triggered test) and `tsc --noEmit` pass.
**General lesson**: any "is this account reachable" flag that's set by an explicit action needs an equally-reliable path back to false when the underlying condition it's tracking (a live connection, in this case) goes away on its own — otherwise it silently drifts stale, and whatever gates on it (like a call-initiation check) starts lying.

### [2026-09-11] Admin login 429 "Too many requests" during repeated testing

**Symptom**: `POST /auth/admin/login` returns 429 after a handful of calls when re-running the Admin Postman/newman collection or otherwise logging in repeatedly during testing.
**Root cause**: Not a bug — `adminLoginLimiter` (`auth.routes.ts`) is a deliberate brute-force guard capping `/auth/admin/login` to a fixed number of requests per 15 minutes per IP, and it counted every request, successful or not. Repeated legitimate test logins burned the same budget meant for blocking password guessing, so normal testing tripped it.
**Affected files**: `src/modules/auth/auth.routes.ts`.
**Fix**: Raised `adminLoginLimiter`'s `max` from 10 to 100 per 15-minute window (user's explicit choice after being offered the option to instead exempt successful logins from the count, or remove the limiter entirely — removal was rejected as a security regression on a route that gates access to money-moving admin functions). Brute-force protection remains in place, just looser.
**Call sites checked**: `adminLoginLimiter` is only attached to `POST /auth/admin/login` (single call site) — no other route affected. Full `auth.test.ts` suite (8/8) and `tsc --noEmit` pass with the new limit.

### [2026-08-09] Pre-existing accounts missing wallet rows → 500 on any wallet-touching endpoint

**Symptom**: `Error: No wallet row for user <id>` thrown from `wallet.service.ts`, surfacing as a 500 on `GET /wallet`, `POST /wallet/dev-credit`, and `POST /calls` (the pre-call balance check). Caught via the Postman collection's newman verification run, not a user report — the collection's example phone number happened to be an account created in an earlier phase, before the wallet tables existed.
**Root cause**: Phase 4 added `wallets`/`host_wallets` tables and wired wallet-row creation into `users.service.ts`'s `createUser` — correct for new signups, but there was no migration/backfill for `users` rows that already existed from before that table was introduced. Any such account has no wallet row at all.
**Affected files**: `src/db/backfillWallets.ts` (new), `package.json` (new `db:backfill-wallets` script).
**Fix**: One-time idempotent backfill script that inserts a missing `wallets` or `host_wallets` row for every existing user based on role. Ran it against the shared dev DB (backfilled 38 user wallets, 18 host wallets). The underlying creation-on-signup code was already correct and untouched — this only fixes pre-existing rows.
**Call sites checked**: `GET /wallet`, `POST /wallet/dev-credit`, `POST /calls` (balance check) — all confirmed working post-backfill via a full newman run (20/20 requests, 0 failures) and the full automated suite (30/30).
**General lesson**: any future table that every `users` row is expected to have a corresponding row in (one-to-one satellite tables) needs this same backfill treatment if it's introduced after real user rows already exist — not just wiring into the signup path.

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

### [2026-08-09] Pre-existing accounts missing wallet rows → 500 on any wallet-touching endpoint

**Symptom**: `Error: No wallet row for user <id>` thrown from `wallet.service.ts`, surfacing as a 500 on `GET /wallet`, `POST /wallet/dev-credit`, and `POST /calls` (the pre-call balance check). Caught via the Postman collection's newman verification run, not a user report — the collection's example phone number happened to be an account created in an earlier phase, before the wallet tables existed.
**Root cause**: Phase 4 added `wallets`/`host_wallets` tables and wired wallet-row creation into `users.service.ts`'s `createUser` — correct for new signups, but there was no migration/backfill for `users` rows that already existed from before that table was introduced. Any such account has no wallet row at all.
**Affected files**: `src/db/backfillWallets.ts` (new), `package.json` (new `db:backfill-wallets` script).
**Fix**: One-time idempotent backfill script that inserts a missing `wallets` or `host_wallets` row for every existing user based on role. Ran it against the shared dev DB (backfilled 38 user wallets, 18 host wallets). The underlying creation-on-signup code was already correct and untouched — this only fixes pre-existing rows.
**Call sites checked**: `GET /wallet`, `POST /wallet/dev-credit`, `POST /calls` (balance check) — all confirmed working post-backfill via a full newman run (20/20 requests, 0 failures) and the full automated suite (30/30).
**General lesson**: any future table that every `users` row is expected to have a corresponding row in (one-to-one satellite tables) needs this same backfill treatment if it's introduced after real user rows already exist — not just wiring into the signup path.

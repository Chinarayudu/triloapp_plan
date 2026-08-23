# CLAUDE.md

Backend for a three-sided video-chat platform (User app, Host app, Admin app — all three frontends built by a separate team; this repo is backend only).

## Project docs — read the relevant one before answering questions in that area

| Doc | Covers |
|---|---|
| [`BRD.md`](BRD.md) | Business requirements — what the system must do and why, numbered `BR-*` requirements |
| [`BACKEND_PLAN.md`](BACKEND_PLAN.md) | Technical architecture — wallet/ledger, per-minute billing, calls, live broadcasting, payments, moderation, 18+ handling |
| [`tech-stack/TECH_STACK.md`](tech-stack/TECH_STACK.md) | Confirmed stack: Node.js, Express, TypeScript, PostgreSQL (Neon), Redis, BullMQ, Socket.io, and everything around them |
| [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) | Build phases, sequencing, timelines, contract-first collaboration model with frontend teams |
| [`UX_SCREENS_AND_FLOWS.md`](UX_SCREENS_AND_FLOWS.md) | Screen-by-screen and flow-by-flow spec for the three frontend apps (handed to design/Figma, not backend-relevant beyond context) |
| [`BUG_HISTORY.md`](BUG_HISTORY.md) | Log of every bug fixed in this repo — checked first on every new bug report |

## How to work in this repo — route based on what's being asked

- **Writing or changing backend code** (new endpoint, new module, business logic, refactor, "implement X", "build Y") → invoke the `dev-standards` skill before writing anything. It sets the coding standard for this repo (simple, explicit, minimally-abstracted — see the skill for the full reasoning). This applies to every change, not just large ones.
  - If the change adds, removes, or changes the request/response shape of an API endpoint, also update `postman/TriloPlan-Backend.postman_collection.json` (and the environment file if a new variable is needed) in the same pass — not as a follow-up. Verify the updated collection actually works with `npx newman run postman/TriloPlan-Backend.postman_collection.json -e postman/TriloPlan-Local.postman_environment.json` against a running dev server before calling the change done, the same as any other test.
- **A reported bug, pasted error/stack trace, or "this isn't working"** → invoke the `debug-issue` skill before touching any code. It requires checking `BUG_HISTORY.md` for a known fix first, mapping every place the affected code is used, and proposing the fix for approval before applying it — do not skip straight to editing code for a bug report.
- **Anything else** (planning, architecture questions, doc updates) → use judgment, referencing the docs table above as needed.

## Non-negotiable for this codebase specifically

This backend moves real money (per-minute call billing, gifting, commission, host withdrawals — `BACKEND_PLAN.md` §1). Code in the wallet/ledger/billing/withdrawal path gets extra scrutiny under both skills above: it should be the most explicit and least abstracted code in the repo, every error path there must fail loudly, and any change to it must go through the full `debug-issue` blast-radius check even for what looks like a small fix.

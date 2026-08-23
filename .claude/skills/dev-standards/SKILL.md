---
name: dev-standards
description: Coding standards for this backend repo (Node.js/Express/TypeScript/Postgres video-chat platform) — write simple, explicit, minimally-abstracted code, Karpathy-style. Use BEFORE writing or editing any backend source code in this project — new endpoints, modules, business logic, or refactors. Triggers on requests to implement, build, add, create, or write code/features/endpoints/modules in this repo.
---

# Backend Coding Standards — this repo

The reference point for these standards is Andrej Karpathy's known coding philosophy (micrograd, nanoGPT, llm.c, the "Zero to Hero" lectures): code that reads top-to-bottom like a clear explanation, minimal ceremony, nothing abstracted until it's actually earned. Applied here to a Node/Express/TypeScript backend that moves real money (see `BACKEND_PLAN.md`).

## Core principles

1. **Clarity over cleverness.** A function should be readable start to finish without jumping across five files to understand what it does. Prefer a plain `for` loop over a dense chain of `.reduce()`/`.flatMap()` if the chain requires real effort to parse. If you have to explain a line, rewrite the line instead.
2. **No abstraction before it's earned.** Don't add an interface, factory, strategy pattern, or generic base class for a single concrete case. Three similar lines of code in three places beats one premature shared abstraction that has to flex for cases that don't exist yet. Add the abstraction on the *second or third* real repetition, not in anticipation of it.
3. **Explicit over implicit.** Pass what a function needs as parameters; avoid hidden reliance on module-level mutable state, ambient context objects, or metaprogramming (decorators, dynamic property injection) unless the framework strictly requires it. A reader should be able to tell what a function depends on by reading its signature.
4. **Small, single-purpose functions and files.** Each function does one obvious thing named after what it does. Organize files by domain (`wallet/`, `calls/`, `live/`, `chat/`, `admin/`, `auth/` — per `tech-stack/TECH_STACK.md`), not by technical layer-for-its-own-sake.
5. **Delete code aggressively.** No commented-out blocks, no unused flags "just in case," no speculative config options for requirements that don't exist yet. Code that isn't there can't have a bug in it.
6. **Comments explain WHY, not WHAT.** Only comment a non-obvious constraint, a subtle invariant, or a workaround for a specific issue — never narrate what the next line obviously does. If deleting the comment wouldn't confuse a future reader, delete it.
7. **Fail loudly and early, especially near money.** Validate at system boundaries (API input via Zod, webhook payloads, env vars at boot) and let internal code trust those guarantees rather than re-checking everywhere. Never silently swallow an error in the wallet/ledger/billing path — an uncaught exception there should be loud, not a quietly-skipped tick.
8. **The money-moving code is where "simple" matters most, not least.** Wallet, ledger, and billing-tick logic (`BACKEND_PLAN.md` §1) should be the *most* explicit, least abstracted code in the repo — no clever generic "transaction processor" framework. A financial bug hidden behind an abstraction layer is much harder to trace than an obvious few lines of straight-line code doing exactly what they say.
9. **Prefer the framework's plain mechanisms over heavy ceremony.** This is Express, not NestJS — plain route handlers and functions over decorator-driven DI unless a specific problem actually calls for it. Don't reintroduce framework-scale ceremony by hand.
10. **Correctness first, then performance — and only with a reason.** Get the simple, obviously-correct version working first. Don't add caching, memoization, or a denormalized read path until there's a measured reason to.
11. **Reproducibility.** Tests should be deterministic — seed any randomness, avoid relying on wall-clock time or real network calls where a fixed fixture will do. Idempotency keys (per `BACKEND_PLAN.md` §1) are part of this same instinct: the same input should always produce the same, predictable outcome.
12. **Prove it works, don't just claim it.** For anything touching a real flow (an endpoint, a billing tick, a webhook handler), exercise it end-to-end before calling it done — see the repo's `verify` skill. Passing a typecheck is not the same as the feature working.

## Before finishing any change in this repo

- Would a newcomer understand this function by reading it once, top to bottom?
- Is there an abstraction here that only has one real use? If so, inline it.
- Does every error path in wallet/billing/withdrawal code fail loudly instead of silently continuing?
- Did unrelated cleanup sneak into this diff? If so, split it out — a feature change and a refactor should not be the same commit.
- Are there comments explaining *what* the code does instead of *why* it's written this way? Remove them.

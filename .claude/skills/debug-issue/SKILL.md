---
name: debug-issue
description: Use whenever the user reports a bug, pastes an error message or stack trace, or describes something broken/not-behaving-as-expected in this backend. Do NOT edit any code until this workflow's proposal step is complete and approved. Triggers on words like bug, error, issue, broken, not working, exception, crash, fix this, or a pasted stack trace/log.
---

# Debug workflow — this repo

Full step-by-step process is in [`debug.md`](debug.md) in this same folder — read it before starting. Short version:

1. **Understand the issue fully** before touching anything — exact symptom, reproduction, what changed recently.
2. **Check `BUG_HISTORY.md`** (project root) for a matching prior fix first. If one matches, verify it still applies to current code and apply it directly.
3. **Find root cause** by reading the actual implicated code path, not guessing from the error text alone.
4. **Map every place the affected code is used** (grep the codebase) before proposing anything — this is what stops a fix for one caller from quietly breaking another.
5. **Propose the fix and wait for approval** — state the root cause, the minimal change, and confirmation that every usage found in step 4 was checked. Do not edit code before this is confirmed, unless the user has pre-authorized autonomous fixes for the session.
6. **Apply narrowly** — only the fix, no adjacent cleanup/refactor riding along in the same change.
7. **Verify no regression** across every usage found in step 4; run relevant tests/typecheck.
8. **Record it in `BUG_HISTORY.md`** so the same or a similar issue resolves instantly next time.

See `debug.md` for the full detail on each step and `BUG_HISTORY.md` for the log itself.

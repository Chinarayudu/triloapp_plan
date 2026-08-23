# Debug Workflow — full detail

Goal: fix the reported issue without disturbing any other flow that touches the same code, and never edit code before the fix has been proposed and understood.

## Step 1 — Understand the issue

- Get the exact symptom: error message, full stack trace (not just the first line), reproduction steps, which app/flow/endpoint is affected, and whether it's new or has always been broken.
- If the user pasted a log or stack trace, read all of it before forming a hypothesis — the real cause is often several frames away from where the exception surfaced.
- If reproduction steps are missing and the report is ambiguous, ask before guessing — a wrong guess here wastes the rest of the workflow.

## Step 2 — Check bug history first

- Open `BUG_HISTORY.md` at the project root and search for a matching or similar signature: same error message, same symptom, same module/flow.
- If a match is found:
  - Don't assume it still applies blindly — the surrounding code may have changed since. Re-read the currently-implicated code and confirm the same root cause is present.
  - If confirmed, apply the documented fix directly (still following steps 4–8 below — history tells you *what* to change, not that you can skip checking blast radius or recording the recurrence).
- If no match, continue to Step 3.

## Step 3 — Find root cause

- Trace the actual code path that produces the symptom. Read the implicated function(s) fully, not just the line the stack trace points at — the bug is often in what's *passed in*, not the line that throws.
- For anything in the wallet/ledger/billing/withdrawal path (`BACKEND_PLAN.md` §1), be especially careful: a symptom like "wrong balance" can originate from a completely different call site than the one that reported it (e.g., a billing tick miscalculating minutes earlier in a call, surfacing only at withdrawal time).
- State the root cause explicitly before moving on — if you can't state it in one or two sentences, you haven't found it yet.

## Step 4 — Map the blast radius: identify every usage

- Before proposing any change, grep/search the codebase for every place the affected function, module, or data shape is used.
- List every call site found, and for each one note: does the planned fix change its behavior, and is that change correct for that caller too?
- This step exists because shared code in this system is genuinely shared across very different flows — e.g., the same debit/commission/credit pattern is used by call billing, gifting, and live-broadcast gifting (`BACKEND_PLAN.md` §1). A fix that's correct for a call-billing bug can silently break gifting if this step is skipped.

## Step 5 — Propose the fix before touching any code

Present, before editing anything:
- The root cause (from Step 3).
- The minimal change needed to fix it — prefer the smallest correct fix over a broader rewrite.
- The full list of call sites from Step 4, with a one-line note per site confirming it was checked and won't regress.
- If the "correct" long-term fix is bigger than the minimal patch (e.g., the root cause is a structural/design issue), say so explicitly and separately — ship the minimal safe fix now, and note the deeper issue rather than scope-creeping the current change.

Wait for explicit approval on this proposal before editing code, unless the user has pre-authorized autonomous fixes for this session (e.g., via an auto-mode instruction).

## Step 6 — Apply narrowly

- Change only what the approved proposal described. No adjacent renames, reformatting, or "while I'm in here" cleanup — that belongs in a separate change, and mixing it in makes it harder to see what actually fixed the bug if this needs to be reviewed or reverted later.

## Step 7 — Verify no regression

- Re-check every call site listed in Step 4 against the change actually applied (not just the plan — confirm the diff matches the proposal).
- Run relevant tests and typecheck. If no automated test covers this path, say so explicitly and suggest adding one — don't silently treat "no test failed" as "verified" when no test exists.

## Step 8 — Record it

Append an entry to `BUG_HISTORY.md` using the template at the top of that file: symptom, root cause, affected files, fix summary, call sites checked, date. This is what makes Step 2 resolve future recurrences instantly instead of re-deriving the same fix.

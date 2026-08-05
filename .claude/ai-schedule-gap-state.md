# ai-schedule-gap close-out — live execution state

**Read this first after any compaction.** It is the authority on what is done,
what is in flight, and every decision already made. Do not re-derive, re-triage,
or re-ask.

- Triage + decisions: `docs/superpowers/specs/2026-08-05-ai-schedule-gap-triage-design.md` (`1dcb61b0`)
- Task-by-task plan: `docs/superpowers/plans/2026-08-05-ai-schedule-gap-closeout.md` (`9a667e82`)
- Mode: subagent-driven. Implementer (Opus, high) → Reviewer (Sonnet) → gap list → repeat until clean and green.

## Standing rules for this programme

- **Do NOT file new issues.** If something is wrong, fix it inline. If it is
  unclear, ask the owner. Only stop and escalate when a fix would widen the
  blast radius beyond the task's stated files.
- Every subagent brief must be **self-contained** — verbatim code, exact paths,
  acceptance criteria, what not to touch, the verify command, an output cap.
  Subagents must not have to re-read the repo to understand the task.
- Reviewer output is a gap list, not prose. Implementer fixes, reviewer re-runs.
- Never accept "done, tests pass" without the raw JSON counts pasted back.
- **Subagents WRITE e2e cases but never RUN them.** Playwright outlives the
  600s subagent watchdog; two agents died to it on the #404 programme. The main
  thread runs e2e in a background bash at the group boundary.
- Every brief carries a **15-line output cap**: counts, paths, deviations,
  blockers. No file contents, no diffs.

## Status

| Issue | Group | Task | State |
|---|---|---|---|
| #388 | — | — | **CLOSED** 2026-08-05, evidence comment. Shipped in `94513cd5` (W5). Secondary "N warnings" ask also settled: `reviewRowCount` is `rows.length` of the same array (`ai-review.ts:87`). |
| #389 | — | — | **CLOSED** 2026-08-05, mitigated. `walletIds` scoping already in `credits.ts:415`; #390 removes the rest. Deliberately did NOT truncate — the shared schema holds `sync:sports` reference data. |
| #394 | C | 1 | **PHANTOM — no production bug.** `single ? divBoardFixtures : actions.board` takes the FALSE branch when `single` is null, so the competition board already receives the whole board. Code and comment agree and always have (both written in `0f374d7a7`). Proven by mutation: at HEAD the new test is green; mutated to `consoleFixtures(divBoardFixtures, …)` it fails with the exact reported symptom. Regression test committed as `37ed6f45` (`test:`, not `fix:`). Owner call 2026-08-05: **close as invalid with the proof; do NOT chase the original symptom** (no repro, and `ai-competition-console.tsx:697` falls back to `c.fixtureId.slice(0,8)`, so an unlabelled row is unreachable via this path). **CLOSED** as not-planned 2026-08-05 with the full proof. Group C is done — no production change shipped. |
| #386 | B | 2, 3 | pending |
| #391 | B | 4 | pending |
| #392 | B | 5 | pending |
| #385 | A | 6 | pending |
| #387 | A | 7 | pending |
| #383 | A | 8 | pending |
| #384 | A | 9 | pending |
| #390 | D | 10, 11 | pending |
| #382 | E | 12, 13, 14, 15 | pending |

## Execution order

```
C (task 1)  →  B (tasks 2-5)  →  A (tasks 6-9)  ∥  D (tasks 10-11)  →  E (tasks 12-15)
```

- **A is ONE implementer pass** (batching rule): tasks 6-9 all edit `ai-console.tsx` and the quote surfaces.
- **A ∥ D** is safe: D touches only `lib/credits.ts` + its tests. No UI, no locale strings, no OpenAPI.
- **E must follow A.** They collide on `ai-console-state.ts` and on `lib/i18n-keys.ts` (both add locale strings; `i18n:gen-keys` regenerates it).

## Worktrees

| Group | Path | Branch | npm ci | engine resolves inside |
|---|---|---|---|---|
| C | `/Users/ashokhein/github/wt-ai-gap-c` | `ai-gap-c-board-wiring` | ✅ | ✅ verified |
| B | `/Users/ashokhein/github/wt-ai-gap-b` | `ai-gap-b-joint-undo` | ✅ | ✅ verified |
| D | `/Users/ashokhein/github/wt-ai-gap-d` | `ai-gap-d-cron-antijoin` | ✅ | ✅ verified |
| A | not created | `ai-gap-a-quote-integrity` | — | — |
| E | not created — create AFTER A merges | `ai-gap-e-open-scheduling` | — | — |

All have `.env.local`, `apps/web/.env.local`, `.claude/agent-memory` symlinked to the main checkout.
Creation script for A and E is in the plan's Appendix.

## Owner decisions — settled, do not re-ask

| # | Decision |
|---|---|
| 388 | Close with evidence comment. Done. |
| 389 | Close as mitigated. No truncate. Done. |
| 382 | ONE PR: entitlement matrix + rolling checkpoint eviction + AI-anchor pruning. |
| 383 | Do NOT auto-run. Show the card at its flat 1 credit; organiser presses the button. Price stays 1 — do not change `freeDraftQuote`. |
| 384 | Seed the solver with `prior.assignments`. `prior.instruction` is IGNORED on the empty path — nothing is re-executed. Do NOT also change the priced adopt path. |
| 385 | Resolve weights + budgets server-side, provide via context. Provider throws with no default. |
| 386 | Server-side, locked, **best-effort** — NOT one transaction. Client sends the checkpoint pairs; server validates the division set equals the apply event's `division_ids` exactly, rejecting a subset with 422. |
| 387 | Inline receipt line (both directions) **plus** a server-side `schedule.ai_quote_mismatch` competition_event. Detection is server-side: the client sends `quoted_credits`, the server compares. |
| Order | C → B → (A ∥ D) → E. |
| Test bar | unit + E2E + smoke + regression on all, EXCEPT tasks 4 and 5 (help article, copy-truth guard) = unit + regression only. |

## Facts established by scouting — do not re-scout

- **`ai-joint-run.ts` does NOT call the rung weight functions.** Only `isRung`/`Rung`. The issue text is wrong. #385's client surface is `ai-quote-card.tsx` (which owns `quoteFor`) and `ai-officials-review.tsx:214`.
- **`quoteFor` is NOT in `ai-rung.ts`.** It is `ai-quote-card.tsx:89-92`, and already takes an optional `weights` — the seam exists.
- **`schedule-board.tsx` is `"use client"` (line 1).** "Thread from the server" means a provider seeded by the RSC that renders the board.
- **`restoreCheckpoint` is NOT a transaction.** `history.ts:379` loops up to 500 `undoDivision` calls, each its own transaction, deliberately ("single-writer append, concurrency-safe").
- **`schedule.applied_multi` carries `division_ids` only.** No checkpoint ids. Anchors live client-side as `JointCheckpoint {divisionId, checkpointId}` (`ai-joint-apply.ts:42`).
- **`undoJointApply` returns `{ok, failed}`.** There is no `undonePartial` field in that file.
- **The wallet id IS the subscription id.** The sweep selects `s.id`; `grantMonthly` builds `monthly:${walletId}:${period}` from it. Anti-join needs no extra join.
- **`orgPlanKey` is imported from `@/lib/entitlements`**, not defined in `credits.ts`.
- **`monthlyPeriod()` is module-private** in `credits.ts:184`, `YYYY-MM` UTC. Already in scope for the sweep.
- **Community save-point cap is 2**, set by V319 (V290's 1 is superseded).
- **Next free migration is V353.** `V344` is taken by `V344__org_has_feature_pass_on_any_plan.sql`.
- **Help tree is `apps/web/content/help/`**, not `content/help/`. English-only, no i18n owed.
- **Dictionaries** are flat dotted-key JSON at `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (8 files per locale; `ui.json` is the one these tasks touch).
- **Telemetry has no helper.** Events are raw `insert into competition_events` at each call site.
- **E2E home is `apps/web/e2e/ai-architect.spec.ts`** for every AI-console case. Mobile is a Playwright project (`--project=mobile-se`), not a manual screenshot. Smoke is `npm run test:smoke` → `scripts/smoke.ts`.

## Existing tests these tasks will break — update deliberately

- `ai-architect.spec.ts:509` — "the officials step prices itself: free draft with no picker" → **Task 8** removes the auto-run.
- `ai-architect.spec.ts:197` — "pro: brief → run → CLEAN → officials → apply → undo" → **Task 8** (extra click) and **Task 3** (undo is one call).
- `history.test.ts:273-282` — asserts the checkpoint 402 → **Task 13** replaces the 402 with eviction. Change it, do not add a contradicting test.

## Verification traps that produce a false green here

- Judge vitest ONLY from `--reporter=json --outputFile`. A suite that fails to **collect** reports `numFailedTests: 0` — read `numFailedTestSuites`.
- `rtk` prints `PASS(0) FAIL(0)` for a collection failure and hides lint output.
- Shell cwd resets to the main checkout between calls. Prefix `cd <abs worktree> &&` in the SAME call as anything you judge.
- A worktree without `.env.local` skips ~1772 DB tests while `total` stays unchanged — only `pending` moves.
- A symlinked `node_modules` compiles MAIN's engine. `readlink -f node_modules/@seazn/engine` must resolve inside the worktree.
- Never `git stash` in a worktree — the stash stack is shared with the main checkout.
- Pre-commit, every commit: `npm run openapi:gen && npm run i18n:gen-keys`, then `git status --porcelain` empty. Both gates are CI-only.

## Log

- 2026-08-05 — triage complete, 12 issues verified against `1ee962f0`. #388 and #389 closed. Spec + plan committed. Worktrees C/B/D created; C has `npm ci`.

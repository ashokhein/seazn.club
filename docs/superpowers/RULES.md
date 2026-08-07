# Project standing rules

Owner-given policy, current as of 2026-08-07. Applies to all work in this
repo, not scoped to one feature or programme. Read this before starting any
task — it is compaction-proof and subagent-readable by design: every
dispatch brief should either restate the relevant parts inline or point here
explicitly, so a subagent never has to guess or re-derive them.

## Skills

Load and use ALL of: every `superpowers` skill, `frontend-design`, `stripe`,
`playwright`, `supabase`, `typescript-lsp`, `code-review`, and the
`seazn-local-env` skill for local environment setup. **Apply them where they
actually help — do not just cite them decoratively.** A dispatch brief that
says "use frontend-design" but never asks for actual design-system-consistent
polish is not compliant.

## Infra

TypeScript **7**. Node **26**. (See `.claude/ts7-migration-state.md` for the
in-flight migration this confirms as current target, not something to avoid.)

## Mindset

Think beyond the literal request. Actively look for gaps, edge cases, and
weak spots in the design, and propose improvements rather than only
implementing what was asked. Balanced against "don't file new issues" below:
surface it, then fix it inline or ask — don't file-and-walk-away.

## Schema

Greenfield project — no production data, no backfills to preserve. Adding
new tables/columns is fine and expected. Prefer a correct schema over a
backwards-compatible one; don't contort a design to dodge a migration.

## Agent topology

- **Scout — Sonnet, High effort.** All read-only exploration, file
  discovery, codebase Q&A.
- **Implementer — Sonnet, xHigh effort.** Writes code. Full access to all
  skills and tools.
- **Reviewer — Sonnet, xHigh effort.** Reviews the implementer's diff,
  reports gaps as a list, not prose.

**Loop**: Implementer → Reviewer → gap list → Implementer → Reviewer → …
repeat until the review is clean AND all tests are green.

**Batching rule**: several tasks touching the SAME files → do them INLINE in
one implementer pass, not separate dispatches. Otherwise, separate
Implementer → Reviewer loops per task.

## Testing — required for every task, all four, stated explicitly in acceptance criteria

- Unit tests
- E2E tests (Playwright)
- Smoke tests (this repo's `scripts/smoke.ts` pattern)
- Regression tests covering the specific bug/behavior being changed

A task is not "done" until all four exist and pass. A task with no literal
UI (a backend/service change) still owes an E2E test — trace forward to the
real user-facing flow that eventually exercises it, don't skip it as N/A.

**Unrelated failures**: don't chase a failure in files/references the
current task didn't touch — skip it, note it clearly, let CI surface it
separately. Don't silently absorb scope.

## UI/UX

Every interface works on both desktop AND mobile — responsive layouts,
touch-friendly targets, no desktop-only interactions.

## Pre-commit

Before every commit: verify the OpenAPI spec hasn't drifted
(`npm run openapi:gen && git status --porcelain` must be empty after).
Regenerate/update if it has.

## Process — compaction resilience, subagent token efficiency

- Document every decision as it's made (spec/plan/this file), not batched at
  the end — undocumented decisions are lost across a compaction, not merely
  summarized.
- Every subagent dispatch is self-contained: full context inline, or an
  explicit pointer to a specific doc/section. No subagent should need to
  re-read the whole repo or re-derive something already decided — that's
  what actually wastes tokens, not verbosity.
- **Do not file new issues.** Ask if unclear. Fix inline if wrong — unless
  the fix would widen the blast radius past the task's stated files, in
  which case stop and escalate rather than silently expanding scope or
  silently ignoring it.

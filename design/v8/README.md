# v8 — Player Accounts · DB Connection Budget

> **Status (2026-07-13):** not started. PROMPT-53 ⏳ · PROMPT-54 ⏳.
> Branches (planned): `feat/v8-player-accounts` (worktree), `chore/v8-db-pool`.
> Migrations: V275 expected in PROMPT-53 (`person_claims` + `fixture_availability`);
> none in PROMPT-54.
>
> **Naming note:** PR #76 ("v8: image-led console cards + division Settings tab")
> shipped 2026-07-13 without a corpus folder — this folder is the first *recorded*
> v8 corpus. If the collision bothers anyone, `git mv design/v8 design/v9` before
> kickoff; prompt numbering (53/54) is global and unaffected.

## Theme

Two unrelated leftovers promoted to a wave:

1. **Player accounts (PROMPT-20c, last tier-1 feature)** — everything so far is
   organiser-operated; `persons.user_id` has existed since V204 and never been
   filled. Claim flow (invite + QR), a cross-org player home with fixtures/results,
   availability RSVP feeding the lineup picker, QR self check-in, and consent
   ownership moving to the claimed player. Closes out the PROMPT-20 spec.
2. **DB connection budget** — the `DB_POOL_MAX` knob shipped in PERF-A but nothing
   sets it, no env has an explicit budget, and the 2026-07-13 stg outage (crash-loop
   → connection leak → FATAL 53300 on `max_connections=60`) showed the failure mode
   is leaks, not steady-state load. Explicit per-env values, rotation guardrails,
   a diagnostics script, and a runbook.

## Prompts

- `prompts/PROMPT-53-player-accounts.md` — claim flow, `/me` player home,
  `fixture_availability` RSVP + organiser grid, QR self check-in, consent handover.
- `prompts/PROMPT-54-db-connection-budget.md` — per-env `DB_POOL_MAX`, budget math,
  `max_lifetime` rotation, `scripts/db-conn-report.ts`, `docs/ops/db-connections.md`
  runbook with the 53300 incident.

# Verified scheduling — wave session prompts

One prompt per issue, run each in a fresh session, in order. Companion to
`2026-07-30-scheduler-verified-output-design.md` and issue #395 (programme index).

**Run order:** #396 → #397 → #398 → #399 → #400 → #401 → #402 → #403 → #404.

**Hard gates:** #397 needs #396 merged · #398 needs #397 · #399 needs #398 ·
#400 and #401 need #398 · #402 needs #396 · #403 after #400 · #404 last
(needs #402 + #403). #402 may run any time after #396 — nothing scheduling-side
blocks on it.

Every prompt carries the standing directives: Superpowers skills
(writing-plans → TDD → verification-before-completion → requesting-code-review →
finishing-a-development-branch), frontend-design skill, Playwright MCP
screenshot verification. Locked owner decisions are embedded verbatim so a
fresh session cannot re-litigate them.

---

## Session 1 — W1 (#396)

```text
Implement issue #396 (W1: participants recursion + bye stripping + person identity at
registration) from the verified-scheduling programme. Read the design doc
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md (especially §2
Decisions, §6 Testing, §7 reuse ledger) and the memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: start with writing-plans against the issue, then
test-driven-development for every change, verification-before-completion before any
success claim, requesting-code-review before merge, finishing-a-development-branch to
close. Load the frontend-design skill and Playwright MCP up front; use them for any UI
surface touched (screenshot-verify desktop + 375px). Load the Supabase Postgres
best-practices skill before writing the migration.

Scope: new set-valued, cycle-guarded participants.ts in packages/engine with stripByes;
pack gains a participants field consumed by placer and verifier; partial unique index
persons(org_id, user_id); scheduling-only (non-persisted) same-name guard. Registration
auto-link is OUT of scope (deferred to #402). Required tests: guardian-with-2-children
anti-merge regression, plus failing-without-it tests frozen from the two real payloads
(badminton + Stepladder) in BOTH directions — verifier must accept valid and reject
invalid. Work in a fresh git worktree, never check out in the main repo dir. Open a PR
(smoke CI runs on PRs only). Closing pass: help pages, i18n for any new user-facing
string (all 4 locales), extend scripts/smoke.ts if behavior changed.
```

## Session 2 — W2 (#397)

```text
Implement issue #397 (W2: calendar anchor — org timezone, clock, resolved window, kill
epoch drafts). Verify #396 (W1) is merged to main first; stop if not. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
Load the frontend-design skill and Playwright MCP up front; screenshot-verify any
touched surface at desktop + 375px.

Scope: new tz.ts (zonedTimeToUtc, dayKeyInTz, …) with `now` injected and never read
directly; pack gains tz, clock, window, sessionHours; epoch sentinel times become null
instead of 1970; new `window` conflict reason (warning-only this wave — blocking comes
in W4). Locked decisions: ONE org timezone governs all temporal math, division tz is
display-only; the J6 joint prompt gets REWRITTEN, not extended; single-division
SYSTEM_PROMPT stays unchanged. Tests frozen from the two real payloads in both
directions, each failing without the change. Fresh git worktree, PR for smoke CI.
Closing pass: help pages, i18n all 4 locales for new strings, smoke.ts if behavior
changed.
```

## Session 3 — W3 (#398)

```text
Implement issue #398 (W3: compile the organiser's instruction into verified hard
constraints). Verify #397 (W2) is merged first; stop if not. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
Load the frontend-design skill and Playwright MCP up front; screenshot-verify any
touched surface at desktop + 375px.

Scope: new schedule-ai-parse.ts stage-1 parser; symbolic dates resolved via W2's clock,
never by the model; resolveParsed with feasibility bump + assumptions logging; verifier
gains typed rules (per-day cap, weekday/date targets, not_before/not_after);
cross-division rest fixed to MAX. Locked decision: the parse round runs OUTSIDE
spendCredit as a free pre-flight with its own token meter and ceiling — a credit buys a
token budget and extra LLM rounds must not mint credits (see schedule-ai.ts spendCredit
call and ai-rung.ts metering). Tests frozen from the two real payloads in both
directions, each failing without the change. Fresh git worktree, PR for smoke CI.
Closing pass: help pages, i18n all 4 locales, smoke.ts if behavior changed.
```

## Session 4 — W4 (#399)

```text
Implement issue #399 (W4: delta-based blocking, rule codes on conflicts, feeder rest).
Verify #398 (W3) is merged first; stop if not. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
Load the frontend-design skill and Playwright MCP up front; this wave changes
board/apply behavior, so screenshot-verify the board flows at desktop + 375px.

Scope: person_overlap and window conflicts become BLOCKING, but strictly delta-based —
only newly introduced or worsened conflicts block; pre-existing conflicts stay warnings
so a dirty board remains editable (write an explicit acceptance test proving a
pre-existing dirty board can still be edited and applied). Conflict.rule code mapping
(reason → H-code, CAP for capacity) to unify rule vocabulary. Feeder rest = feeder
match end + effectiveRest. Tests frozen from the two real payloads in both directions,
each failing without the change. Fresh git worktree, PR for smoke CI. Closing pass:
help pages, i18n all 4 locales, smoke.ts if behavior changed.
```

## Session 5 — W5 (#400) — UI wave

```text
Implement issue #400 (W5: AI review panel — instruction preview, assumptions,
unschedulable; absorbs #388). Verify #398 (W3) is merged first; stop if not. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
This is the programme's main UI wave: load the frontend-design skill BEFORE designing
the panel and follow it for aesthetic direction — this is a user-facing organiser
surface, full polish bar (not /admin). Use Playwright MCP to screenshot-verify every
state at desktop AND 375px with no horizontal page scroll.

Scope (ai-console.tsx board component): compiled-instruction preview with a confirm
gate that spends NO credit if the organiser declines; render the currently-dead
AiSchedulePlan.assumptions field as rows; render unschedulable rows with reason and a
division chip on the joint console; redefine the "N warnings to review" count. Beware
the RSC-payload trap: assertions on Next HTML must anchor on `="`, bare data-* probes
are vacuous. Every new user-facing string goes in all 4 locale dictionaries — never
hardcoded English (run gen-keys + i18n:check). Tests failing-without-it for the
credit-not-spent-on-decline gate. Fresh git worktree, PR for smoke CI. Closing pass:
help pages (English tree only), smoke.ts extension for the confirm gate.
```

## Session 6 — W6 (#401)

```text
Implement issue #401 (W6: z3 minimal-movement repair engine). Verify #397 and #398 are
merged first; stop if not. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md (§3 architecture,
§8 risks) and memory file project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
Load the frontend-design skill and Playwright MCP up front; screenshot-verify any
touched surface at desktop + 375px.

Scope: new repair.ts importing rule semantics from calendar.ts (never duplicating
them); ascending-k search for minimal fixture movement. Locked decisions: NO
fixture-count gate — solve the full 500-movable range, higher latency accepted; the
real bound is TERMINATION, so enforce a finite wall-clock solver budget with a
telemetry-visible fallback to LLM repair on timeout. Must be deterministic (fixed
seed/order/pinned solver version). z3 runs as in-process WASM — lazy-import it so the
LLM-only path never loads it, and it is NOT a sub-processor (no legal work owed).
Tests: minimal-movement cases frozen from the two real payloads, timeout-fallback path
exercised, determinism asserted (same input → same output twice). Fresh git worktree,
PR for smoke CI. Closing pass: help pages, i18n all 4 locales, smoke.ts if behavior
changed.
```

## Session 7 — #402 (registration user_id)

```text
Implement issue #402 (registration mints a duplicate person per entry — capture a
session user_id to link them). Verify #396 is merged first (its partial unique index
persons(org_id, user_id) is a hard dependency); stop if not. Read the design doc
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
Load the frontend-design skill and Playwright MCP up front; screenshot-verify any
touched registration surface at desktop + 375px. Load the Supabase Postgres
best-practices skill before the migration.

Scope: nullable registrations.user_id populated when the registrant is signed in;
materialise resolves an existing person by (org_id, user_id) before inserting a new
row. Critical constraint: registration is currently ANONYMOUS — RegistrationRow has no
user column and the insert captures no session — and contact_email is NOT a safe join
key (a guardian registering two children shares one address; linking on it merges
siblings). Name/dob matches are suggest-only, NEVER auto-merge. Tests: signed-in
registrant across two divisions yields ONE persons row; anonymous flow unchanged;
guardian two-children case stays two persons. Fresh git worktree, PR for smoke CI.
Closing pass: help pages, i18n all 4 locales, smoke.ts if behavior changed.
```

## Session 8 — #403 (data protection review)

```text
Execute issue #403 (data protection review for the verified schedule output
programme). This is an audit + copy wave, not a feature build. Run it after #400 is
merged (its preview copy is in scope). Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md first — the GDPR posture is MATURE (legal
pages, LEGAL_VERSION stamp, /api/consent, /api/users/me/export, persons.consent
already exist); audit against it, do not rebuild it.

Use Superpowers skills throughout: writing-plans first, verification-before-completion
before claiming any checklist item closed, requesting-code-review for any code/copy
change, finishing-a-development-branch. Load the frontend-design skill and Playwright
MCP up front; screenshot-verify any copy change on legal/preview surfaces at desktop +
375px.

Checklist from the issue: confirm z3 needs no data-protection work (in-process WASM,
not a sub-processor); name guard is not Art.22 ADM but must stay non-persisted,
scheduling-scoped, disclosed in assumptions, with a privacy-page note; #400 preview
copy must not invite free-text personal data; write the merge-tool requirements that
#404 must satisfy (audit trail, reversibility, consent resolves to more restrictive,
re-verify published schedules); close the outstanding OpenRouter/Vertex/xAI
sub-processor sign-off. Any user-facing copy change → all 4 locales; legal page edits
are user-facing. Deliverable: findings posted on the issue + small copy PRs. Fresh git
worktree for any code change, PR for smoke CI.
```

## Session 9 — #404 (merge tool) — UI wave

```text
Implement issue #404 (duplicate-person review queue + merge tool). Verify #396, #402
and #403 are done first — #403 defines the compliance requirements this tool must
satisfy; stop if its merge-tool requirements are not posted. Read
docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md and memory file
project_verified_scheduling_programme.md before touching code.

Use Superpowers skills throughout: writing-plans first, then test-driven-development,
verification-before-completion, requesting-code-review, finishing-a-development-branch.
This is a UI wave: load the frontend-design skill BEFORE designing the queue and merge
flow, and use Playwright MCP to screenshot-verify every state at desktop AND 375px
with no horizontal scroll (wide tables in overflow-x:auto). Decide the surface first:
if it lands under /admin the bar is functional-only; if organiser-facing, full polish.
Load the Supabase Postgres best-practices skill before any schema/migration work.

Scope: ranked duplicate-suggestion queue (name/dob/shared entrant history), human
confirmation REQUIRED for every merge — no auto-merge ever; full audit trail;
reversible merges; consent fields resolve to the MORE RESTRICTIVE value;
entrant_members repoint to the survivor respecting the PK constraint; re-verify
published schedules after each merge. Tests: merge + reverse round-trip, consent
resolution, PK-safe repoint, re-verify trigger — each failing without the change.
Every user-facing string in all 4 locales. Fresh git worktree, PR for smoke CI.
Closing pass: help pages, smoke.ts extension.
```

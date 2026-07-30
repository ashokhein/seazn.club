# Verified schedule output — single and multi division

Date: 2026-07-30
Status: approved (brainstorming), pending implementation plan

Scope of this document: the whole programme at design altitude, so that nothing from
the source material is lost. Only Wave 1 proceeds to a detailed implementation plan
now; each later wave gets its own spec-plan-build cycle against this design.
Source material: `SCHEDULING-DESIGN.md` + 8 TypeScript files, an outside-in redesign
written against this project's own two production payloads (badminton
double-elimination, single division; Stepladder Showcase, multi division).

## 1. Problem

The source document's headline thesis — *build the verifier before the generator* —
is already true here. `packages/engine/src/scheduling/calendar.ts` holds one
`validateAssignments`, shared by the greedy placer, the drag-drop board and both AI
runners, and `effectiveRestMinutes` exists precisely so those callers cannot disagree
about what a rule means.

So the value in the source material is not its architecture. It is a gap list, and
every gap on it was reproduced against our code before being accepted here.

| # | Gap | Evidence in this repo |
|---|---|---|
| 1 | Person rules are vacuous on elimination brackets | `schedule-ai.ts:896` and `competition-schedule-ai.ts:767` derive `people` from `[home, away].filter(non-null)`. A TBD slot carries nobody, so 10 of the badminton payload's 13 fixtures constrain nothing. |
| 2 | No calendar anchor, no window | `SchedulePack` (`schedule-ai.ts:214`) has no `clock` and no `window`. The draft is built with `toSlotConfig(settings, 0)` (`:411`) and `startAt` is optional (`schedule.ts:322`), so a division with no configured start emits **1970-01-01 draft timestamps to the model** (`:418`). With empty `sessionWindows` nothing bounds output dates: 03:00 verifies clean. |
| 3 | The organiser's instruction is never verified | `verifyConfig` carries rest, blackouts, session windows and match length only. "two matches per day", "final on Friday", "45 minute gap" are unverifiable, so repair rounds cannot converge on what was actually asked for. |
| 4 | The publish gate permits impossible boards | `isBlocking` (`schedule-ai.ts:838`) blocks on `court` and direct `order` only. `person_overlap` is a warning (`calendar.ts:102`), so a human booked on two courts at once applies and publishes. |
| 5 | Two vocabularies | The prompt teaches `H1`–`H7` / `J1`–`J7`; the verifier reports `{reason: "rest"}`. A repair round hands the model a word it was never taught. |
| 6 | Day boundaries are undefined across zones | The joint pack renders each division in its own tz plus a `canonicalTz` for foreign obstacles (`competition-schedule-ai.ts:513`). The moment a per-day cap or a weekday target exists, "two per day" has no single answer. |
| 7 | Feeder rest is zero | `calendar.ts:510` checks `target.startAt < source.endAt` — a dependent fixture may start the instant its feeder ends. The advancing player gets no recovery. |
| 8 | Same human, two `person_id`s | See §2. |

### 1.1 Identity: the cause is a write, not a read

The schema is correct and the scheduler's read is correct. `entrants` →
`entrant_members` → `persons`, and the pack's shared-player map is built from
`entrant_members` filtered to `ents.size >= 2` (`schedule-ai.ts:528-547`). Two
entrants sharing a `person_id` correctly produce a person conflict.

The writes do not cooperate:

- `registrations.ts:398` — every confirmed *individual* registration performs an
  unconditional `insert into persons`. No lookup by `user_id` (which `persons` has,
  `V204__persons.sql:12`), none by `external_ref`. The same human entering two
  divisions receives two `person_id`s, so `ents.size` is 1 for each and the sharer is
  invisible.
- `registrations.ts:411` — team rosters mint a fresh person per roster name on every
  confirm.
- `entrants.ts:35` — states it as policy: *"Inline persons are never merged with
  existing org persons."*
- Only bulk import resolves identity: `packages/engine/src/import/plan.ts:263-281`
  matches `personsByName` (name key plus dob) against a full persons snapshot and
  emits `person.create` only on a miss. That matcher is the reusable precedent.

A second, independent blind spot: single-division packs read entrants
`where division_id = ${divisionId}`, and sibling divisions arrive as obstacles with
`people: []` (`schedule-ai.ts:917`). Even with a correctly shared `person_id`, a
cross-division clash cannot be seen in single-division mode by construction. Only the
joint runner can see it.

**`contact_email` is not a safe join key.** `registrations.contact_email`
(`V118__registrations.sql:82`) is the *contact*, not the player. A guardian
registering two children uses one address for both; auto-linking on it would merge
siblings into one person, which is worse than the bug being fixed.

**And no safe key exists on the registration path today.** `RegistrationRow`
(`registrations.ts:236-264`) carries `display_name`, `contact_email`, `dob`, `gender`
and `guardian_*`; the insert (`:884-901`) captures no session user. Public
registration is anonymous by design — identified by email plus an access-token hash
(`V118__registrations.sql:71`). Neither `user_id` nor `external_ref` is available
there. `persons.user_id` exists (`V204__persons.sql:12`) but is filled by the V276
claim flow, after the fact.

So "fix the cause at registration" cannot ship as originally written. The cause fix
is narrowed to capturing a session `user_id` on registration when one exists, filed
separately (§9), and it only ever helps signed-in registrants. The scheduling-only
name guard therefore carries the load: it covers every registration, anonymous
included.

## 2. Decisions

| Decision | Choice |
|---|---|
| Capture shape | Index issue plus one child per wave, label `ai-schedule-gap`. Full spec and plan for W1 only; each later wave gets its own cycle. |
| Identity | Ship a scheduling-only name guard, which covers every registration including anonymous ones, plus the `persons(org_id, user_id)` partial unique index. The cause fix at registration is **deferred**: no deterministic key exists on that path today (§1.1), so capturing a session `user_id` is filed as its own issue. Never auto-link on bare email. |
| Blocking | `person_overlap` and the new out-of-window reason block on both the AI apply path and the drag-drop board, **delta-based**: only conflicts a change introduces or worsens. |
| Day boundary | One organisation timezone governs all temporal math. Per-division `tz` becomes display metadata. |
| Solver | z3 minimal-movement repair is in this programme, sequenced last because its encoding cannot exist before the window and the typed constraints do. |
| Strategy | Additive layers on the existing pipeline, with the placement rule from §3. |

### 2.1 Cost of the timezone decision, accepted knowingly

`sessionHours` — the `HH:MM` daily fallback — becomes organisation-zoned. A Malaga
division under a London organisation shifts by an hour. The escape hatch is explicit
`sessionWindows`, which are absolute instants and therefore unaffected; a division
needing different local hours sets them.

`organizations.timezone` already exists (`V305__org_timezone.sql`) with the
resolution chain `schedule_settings.tz → organizations.timezone → 'UTC'`, described
there as "the VENUE lane, inherited by divisions". No migration is required.

Consequence for the prompts: `J6` is **rewritten**, not extended. It is the one place
where the joint prompt does not stay purely additive.

## 3. Architecture

Placement rule: every *pure* new primitive lands in `packages/engine`; `usecases`
keeps only the impure parts (DB reads, provider calls, metering). This is what gives
the solver its safety property — the verifier and the solver import one
implementation of every rule semantic and therefore cannot disagree.

**`packages/engine/src/scheduling/` — zod only; no DB, no provider, no wall clock**

| Module | State | Contents |
|---|---|---|
| `tz.ts` | new | `zonedTimeToUtc`, `dayKeyInTz`, `hhmmInTz`, `ymdAddDays`, `weekdayOfYmd`, `makeClock(now, tz)` — `now` always injected |
| `participants.ts` | new | `computeParticipants` (set-valued, memoised, cycle-guarded), `stripByes` |
| `constraints.ts` | extend | `HardConstraint` zod union, `ConstraintScope`, `FixtureSelector`, alongside the existing `SchedulingConstraints` |
| `calendar.ts` | extend | new `window` `ConflictReason`; feeder rest; per-day cap; weekday/date targets; participants-aware person checks; cross-division rest as MAX; `rule` code on `Conflict` |
| `repair.ts` | new (W6) | z3 encoding, importing every rule semantic from `calendar.ts` |

**`apps/web/src/server/usecases/` and components — impure**

`schedule-ai-parse.ts` (new, stage-1 compiler) · `schedule-ai.ts` and
`competition-schedule-ai.ts` (pack gains `tz`, `clock`, `window`, `participants`,
`parsed`) · `registrations.ts`, `entrants.ts` (identity auto-link) ·
`components/v2/board/ai-console.tsx` (preview, assumptions, unschedulable).

### 3.1 Wave order

Arrows are hard dependencies, not preferences.

```
W1  participants + byes + identity           (no dependency)
W2  tz + clock + window + sentinel kill      → needs tz.ts
W3  instruction compiler + typed-rule verify → needs W2 (symbolic dates need a clock)
W4  delta-blocking + rule codes + feeder rest → needs W3 (the `window` reason must exist)
W5  review panel: preview, assumptions, #388 → needs W3 for the preview; the
                                                assumptions and unschedulable rows can
                                                land earlier
W6  z3 minimal-movement repair               → needs W2 + W3 (no window, no domain)
```

W1 adds one index migration but no behavioural write change. W2 is the only one that changes what the
model sees without changing what is enforced. W4 is the only one that changes what an
organiser is permitted to do.

**Feeder rest (gap 7) is deliberately placed in W4, not W1**, though it needs nothing
from W2 or W3. Direct `order` conflicts block *today*, so adding `+ effectiveRest` to
the check at `calendar.ts:510` would make previously legal boards emit a blocking
conflict, and any subsequent edit to such a board would 409. It is only safe once
delta-based blocking exists to let a pre-existing violation through as a warning.

## 4. Data flow

```
instruction (free text)
  └─▶ stage-1 compiler (LLM, schema-forced, symbolic dates only, one retry)
        → RawParsed { hard[], soft[], unparsed[] }        ── outside spendCredit
  └─▶ pack builder (deterministic)
        makeClock(now, orgTz) · resolveParsed → window + hard[] + assumptions
        stripByes · computeParticipants · merge settings.constraints
        null out sentinel draft times
  └─▶ preview: "read as …" + assumptions ── organiser confirms ──▶ spendCredit
  └─▶ architect LLM (existing runners, control flow unchanged)
  └─▶ verify: validateAssignments, participants-aware, + window + typed rules + feeder rest
  └─▶ repair: LLM rounds → z3 minimal movement (W6)
  └─▶ apply: delta-blocking gate
```

**The highest-leverage single change.** `toEngineAssignments` (`schedule-ai.ts:896`)
and its joint twin (`competition-schedule-ai.ts:767`) must read
`pack.participants[fixture_id]` instead of deriving `people` from named entrants.
Small diff; it is what makes every person rule fire on elimination brackets for the
first time.

### 4.1 Contract deltas

- Pack gains `tz`, `clock`, `window`, `participants`, `parsed { hard, soft, unparsed, assumptions }`.
- `Conflict` gains `rule?: RuleCode`, so a repair round speaks the vocabulary the
  prompt taught (gap 5). The mapping is fixed and exhaustive, and is defined once in
  `calendar.ts` beside the `ConflictReason` union rather than at each call site:
  `court → H2`; `blackout` and the new `window` → `H3`; `rest` and `person_overlap`
  → `H4`; `start_window` → `H5`; `order` → `H6`; and typed-instruction violations
  → `H8`. `no_slot` has no rule code — it is the capacity case and carries `CAP`.
- `Assignment.people` is sourced from `participants`, not from named entrants.

### 4.2 Identity flow

```
registration confirm ─▶ unchanged in this programme — no deterministic key exists
                        on the registration path (§1.1). Deferred to its own issue.
scheduler pack       ─▶ entrant_members, ents.size ≥ 2            (real identity)
                     ─▶ name guard: identical normalised names, different person_ids,
                        same run → one synthetic PersonKey for person rules ONLY,
                        recorded in assumptions; persons rows untouched
```

The synthetic key never leaves the pack. Nothing writes it and nothing renders it as
a merge. It exists so a schedule is safe before the data is clean, and it disappears
on its own once registration auto-link and a merge make the real `person_id` shared.

The asymmetry that justifies it is the source document's, and it is right for
*scheduling*: a false merge costs one unnecessary rest gap, a false split books one
human on two courts. It is **wrong for records** — merging two real different people
corrupts stats, discipline history, photo and consent. Hence: over-constrain the
schedule, never the database.

## 5. Error handling

**Stage-1 parse fails schema twice.** Hard fail, never a guess — but not a 422 that
kills the run. It surfaces at the preview: *"couldn't compile your instruction — run
it as a preference instead?"* Silent fallback is refused: it would present a rule as
enforced while nothing enforces it.

**`unparsed` non-empty.** Rendered verbatim in the preview, never converted into a
rule.

**Ambiguous window.** The resolver picks the feasible reading, records why in
`assumptions`, and the preview shows it. The organiser sees the interpretive choice
rather than suffering it.

**Capacity overflow.** No single rule is violated — the schedule cannot exist. New
`CAP` reason on `unschedulable`, rendered through the list #388 asks for.

**z3 infeasible.** Unsat core → constraint families → human text. Never publishes.

**Delta-blocking.** Requires a stable conflict identity; reuse the
`${fixtureId}|${reason}|${detail}` key already used by `verifyJoint`'s dedup and by
the apply path. Pre-existing conflicts pass through as warnings so a dirty board stays
editable; only newly introduced ones return 409.

**Identity races.** `materialise` is already idempotent under a row lock. Add a
partial unique index on `persons(org_id, user_id) where user_id is not null` — the one
key deterministic enough to enforce in the database. Name and dob stay code-side
suggestions, never constraints.

**Invalid IANA timezone.** `lib/tz isValidIana` already exists (`V305`); falls back to
UTC.

### 5.1 Credits and the parse round

Credits are priced up front by the quote and reserved once around the whole run:
`spendCredit(walletId, orgId, quote.credits, …)` at `schedule-ai.ts:1670`, reserve →
run → settle on success, release on failure. A credit buys a **token budget**
(`createTokenMeter(quote.budget)`), not a number of rounds. **The parse round
therefore does not cost an additional credit.**

Only generation tokens are metered (`ai-rung.ts:263-265`); input is not. Parse emits a
small JSON constraint object, roughly 200–400 output tokens against a 32K budget.

The preview introduces an abort point that did not previously exist, so **parse runs
outside `spendCredit`**, as pre-flight, with its own small meter and its own
`clampRound` ceiling (~1K). The reservation happens when the organiser confirms. This
keeps "one credit, one architect run" literally true and makes walking away free.
Abuse exposure is ~400 output tokens per abort, behind the rate limit already in place
(#391, three per hour per competition).

Consequence: parse spend sits outside `quote.budget` and needs its own line in the
ledger stamp, or it is invisible — the exact reconciliation complaint #387 makes.

## 6. Testing

Principle taken wholesale from the source document: **test both directions.** A
verifier that only rejects is untested where it matters most. Fixtures are the two
real payloads, frozen.

| Wave | Rejection case | Acceptance case |
|---|---|---|
| W1 | two entrants, same name, different `person_id` → person conflict fires; **`persons` row count unchanged** | `participants(gf)` = all 7 entrants; `participants(lb-r0-i0)` = exactly `{d, e}` |
| W1 | **guardian, two children, one `contact_email` → TWO persons rows** (anti-merge; must never regress) | the partial unique index rejects a second `persons` row with the same `(org_id, user_id)` |
| W2 | epoch draft → 13 window violations | DST: New York 10:00 = 14:00 UTC in August, 15:00 UTC in January |
| W2 | — | one-day window, 2/day cap, 13 fixtures → extends a week and records the assumption |
| W3 | Stepladder original draft reproduces its exact violation set, **cross-division Fischer named** | badminton golden 7-day schedule verifies with **zero** violations |
| W3 | "at least 40" against `perEntrantMinRest: 0` → 40 (raises, never lowers); unparsed stays verbatim | both real typo-bearing instructions compile to the expected constraint sets |
| W4 | a change introducing a person overlap → 409 | a dirty board with a *pre-existing* overlap stays editable |
| W5 | — | preview, assumptions and unschedulable (#388) all render; 375px clean |
| W6 | infeasible pack names the constraint family | 13-violation Stepladder → verifier-clean, both finals Friday; golden plus one injected clash → **exactly one fixture moves, twelve anchors untouched** |

Cross-cutting, per repository rules:

- **Determinism** — the existing double-seed golden-pack test stays green. `now` is
  injected, never read; that is a hard constraint on every W2 signature.
- **Golden pack updated exactly once per wave**, as a deliberate reviewed diff.
- **Vitest counting** — run full suites, never path-filtered positionals; verify with
  `--reporter=json` when a summary looks suspicious.
- **e2e locally** against a production build with `E2E_PROD_TARGET`; `e2e.yml` stays
  disabled.
- **Ledger test** for the W3 parse line (#387).
- **i18n** — every new string in all four locales; `gen-keys` and `i18n:check`.
- **Help pages** — mandatory closing pass; English tree only.
- **`scripts/smoke.ts`** extended per wave, pro and free paths.

## 7. Complete reuse ledger

Every mechanism in the source material, with a verdict. Nothing is dropped silently.

### 7.1 Adopt near-verbatim

| Source | Destination | Required edit |
|---|---|---|
| `stage2` calendar block: `zonedTimeToUtc`, `dayKeyInTz`, `hhmmInTz`, `ymdAddDays`, `weekdayOfYmd`, `makeClock` | `engine/scheduling/tz.ts` | `.ts` import extensions only. We have `zonedIso` (instant → zoned string) but **no** inverse; the fixpoint over `Intl`, with its "24:00" guard, is genuinely new capability. |
| `computeParticipants` | `engine/scheduling/participants.ts` | **Set-valued.** Their `personOf: Map<string, PersonKey>` is singular — one person per entrant. Ours is `Map<entrantId, personId[]>` because an entrant is a team. Copied as-is it would drop every roster member but one. |
| `stripByes` | `engine/scheduling/participants.ts` | none |
| `resolveParsed`, including the window feasibility bump | `usecases/schedule-ai.ts` | epoch ms at the engine edge, ISO at the API edge |
| `stage1-parse.ts` (PARSER_PROMPT, symbolic `DateRef` schema) | `usecases/schedule-ai-parse.ts` | route through our provider seam and `zodOutputFormat`; their `LlmFn`, fence-stripping and manual retry loop are redundant. Charge to a meter. |
| `smoke.ts` payload fixtures | vitest `__tests__` | remap their `H`-codes to our `ConflictReason`; drop their `check()` harness |

### 7.2 Adopt as specification, rewrite the code

`stage4-verifier.ts` is not a replacement for `validateAssignments`. These parts are
bolted in:

- Window bound → new blocking `window` reason.
- Per-day cap, bucketed by `dayKeyInTz` in one timezone.
- `resolveSelector` — near-verbatim; terminal is `winner_to === null`, never a round
  number.
- `effRestPerson` / `effRestFeeder` cross-division MAX. Our joint verifier runs one
  pass **per division with that division's own config** (`verifyConfigFor`), so a
  cross-division pair is checked twice at two different rest values instead of once at
  the maximum. Theirs is more correct; keep our function name and signature.
- Feeder rest (gap 7) — roughly a three-line change to the existing loop at
  `calendar.ts:510`.
- `scopeCoversFixture` with `kind: 'person'` reading `participants` — the bridge that
  makes person-scoped rules expressible.

`scheduling-contract.ts` is reused as **type vocabulary only**: `HardConstraint`,
`ConstraintScope`, `FixtureSelector`, `CAP`. Rewritten as zod (we are zod-first; they
are plain TypeScript). `divisionsInteract()` is adopted as an auto-router — a joint
request whose divisions share no person and no court runs N cheap single passes, a
direct saving under token-weighted billing.

### 7.3 Adopt as prompt content only

From `scheduling-prompts.ts`, five sentences, landing in a **new additive constant**
so `SYSTEM_PROMPT` stays byte-frozen behind its golden snapshot:

1. The `participants` paragraph.
2. "Never reason 'the slot is null, so nobody is there yet'."
3. "`feeds.after` is the sole ordering authority; `round` and `seq` are display
   labels — elimination brackets number sparsely, so never repair gaps in round
   numbers."
4. Cross-division rest is the MAX of both divisions' values.
5. An unqualified "the final" means every division's terminal fixture.

`J6` is the exception: rewritten, not extended, per §2.1.

### 7.4 Reject

- **Their pack shapes** (`ContextPack`, `SingleDivisionPack`, `MultiDivisionPack`).
  We have `SchedulePack` / `CompetitionPack` with golden tests and a live wire
  contract.
- **`PersonKey = "name:<normalised>"` as a persisted identity.** We have real
  `persons` and `entrant_members`. Name matching belongs at registration as a
  suggestion, and in the scheduler only as the non-persisted guard of §4.2.
- **`stage5-pipeline.ts` entirely.** `scheduleWithVerification` is a strictly weaker
  `runAiPlan`: no token meter, no model ladder, no best-plan retention, no corrective
  structural round, no cost accounting, no timeout.
- **`EXPLAINER_PROMPT`.** A second LLM call for what the existing `summary` field
  already returns without one. Recorded as a product idea, not a build item.
- **CP-SAT sidecar.** Their own §7 trigger is not met.

### 7.5 Adopt later in this programme

`stage3b-z3-repair.ts` → `engine/scheduling/repair.ts` at W6. Reusable structure:
tracking literals producing a coarse unsat core, ascending-*k* search with solver
push/pop, `buildDayIntervals`. Rework required:

- The encoding is pairwise O(n²) integer disjunctions with a fresh `check()` per *k*.
  Our cap is 500 movable fixtures — 125k pairs. Their "milliseconds at tournament
  scale" claim is unproven at our ceiling. **Owner decision (2026-07-30): no
  fixture-count gate — solve the full range, higher latency on large boards is
  acceptable.** The binding constraint is not latency but *termination*: a generous
  but finite wall-clock solver budget, falling back to LLM repair on timeout, with the
  fallback visible in telemetry. If ascending-*k* rather than the encoding proves to be
  the bottleneck, binary search over *k* keeps the same minimality guarantee with
  logarithmically fewer `check()` calls.
- Their engine places **all** fixtures and returns `infeasible` on overflow. Ours must
  retain drop-and-mark-unschedulable, which is a product decision belonging upstream.

## 8. Risks

| Risk | Mitigation |
|---|---|
| `sessionHours` shifts for a division whose tz differs from its org | Explicit `sessionWindows` are absolute instants and unaffected; documented as the escape hatch |
| Delta-blocking mis-keys and locks an organiser out of a dirty board | Reuse the existing conflict key; acceptance test asserts a pre-existing conflict stays editable |
| The name guard treats two different people as one | It is scheduling-only and non-persisted: it costs one unnecessary rest gap and writes nothing. The guardian anti-merge test is a permanent regression guard against ever making it a record merge |
| Deferring the registration cause fix leaves duplicates accumulating | The name guard covers them for scheduling; the review queue and merge tool clear them later. Accepted knowingly, recorded in §9 |
| Parse spend invisible in the ledger | Its own stamp line, tested (#387) |
| z3 does not terminate on a 500-fixture board | No size gate (owner decision); a finite wall-clock solver budget with fallback to LLM repair, and the fallback reported in telemetry rather than degrading silently |
| Golden pack churn hides a real change | Updated exactly once per wave as a reviewed diff |

## 9. Out of scope

Capturing a session `user_id` on registration (a nullable `registrations.user_id`,
populated when the registrant is signed in, auto-linked in `materialise`). This is the
cause fix for gap 8, deferred because it is new capability rather than a bug fix, it
requires a migration and a public-route change, and it only ever helps signed-in
registrants. Filed separately.

Duplicate-person review queue, organiser-facing merge tool, and the production
backfill of historic duplicates. Each is real work and each is a consequence of §1.1,
but none blocks the scheduling waves once the name guard is in place. Filed as #404.

Re-verifying already-published schedules after an admin person-merge (the source
document's §4.1 operational consequence) belongs with that tool: a merge can *create*
overlap violations in a board that was valid when published. Same verifier, another
job. Tracked on #404.

### 9.1 Data protection

Reviewed rather than assumed; findings on #403. Three conclusions worth carrying:

- **z3 requires no data-protection work.** It is an in-process WASM library — no
  personal data leaves the process and it is not a sub-processor. The
  sub-processor question applied to hosted solvers, which were rejected.
- **The name guard is the one new processing activity** in the waves. Not Art. 22
  automated decision-making — the effect is which time a match is played. Mitigated by
  being non-persisted, scheduling-scoped and disclosed in `assumptions`.
- **The merge tool is where the real exposure sits**, not the scheduling waves: it
  changes records covering `dob`, photos and minors, so audit trail, reversibility and
  restrictive-wins consent resolution must be designed in rather than retrofitted.

# ai-schedule-gap: triage and close-out design

Date: 2026-08-05
Label: [`ai-schedule-gap`](https://github.com/ashokhein/seazn.club/issues?q=is%3Aissue+label%3Aai-schedule-gap)
Scope: the 12 issues filed off PR #359 (token-weighted credits #348 + joint scheduling #350) and the #395 programme reviews.

## 1. Status, verified against the tree at `1ee962f0`

Every row below was reproduced or refuted by reading the current code, not by
trusting the issue text. All 12 are open on GitHub; one is already shipped.

| # | Title | Real state | Evidence |
|---|---|---|---|
| 388 | `plan.unschedulable` never rendered | **shipped, close it** | `ai-review-panel.tsx:151,170`, `ai-review.ts:29,44,68`; commit `94513cd5` (W5, #400). Help article documents it at `ai-scheduling.md:136` |
| 389 | shared test schema accumulates ~18k orgs | **mitigated, close it** | `credits.ts:415` takes `opts.walletIds`; the two named tests are scoped. #390 removes the rest of the pressure |
| 382 | open board + constraints to all plans | pending | no entitlement migration exists; the issue's `V344` filename is taken |
| 383 | officials free draft spends 1 credit, no pre-spend surface | pending | `officials-ai.ts:1142-1168`, `spendCredit` unconditional |
| 384 | empty-instruction adopt is discarded | pending | `officials-ai.ts:901` returns `draftAsPlan(pack)`; `pack.prior` reaches only the diff at `:756` |
| 385 | `AI_RUNG_*` invisible to client quote cards | pending | `ai-rung.ts:32` computed `process.env[name]`; 7 client modules import it |
| 386 | joint undo is N restores | pending | `applyCompetitionSchedule` (apply) exists; no competition-scoped restore route |
| 387 | nothing compares `plan.credits` to the quote | pending | zero occurrences repo-wide |
| 390 | billing-grant cron re-sweeps every wallet daily | pending | `credits.ts:445` — no anti-join, `orgPlanKey` still one query per row |
| 391 | joint 3/hour limit undocumented | pending | `ai-scheduling.md:173` documents 5/hr twice; joint limit absent from the "two more limits" block at `:187` |
| 392 | copy-truth guard for the joint-undo sentence | pending | sentence is correct at `:181`; no guard pattern in `copy-truth.ts` |
| 394 | board hands the joint console an empty fixture list | **PHANTOM — see §8** | the ternary is correct; `single` null takes the `actions.board` branch |

Two corrections to the issue text, both of which would waste an implementer's time:

- The help tree is `apps/web/content/help/`, not `content/help/`. #391 and #392 both cite the wrong path.
- Next free migration is **V353**. #382 specifies `V344__open_scheduling_entitlements.sql`; that number now belongs to `V344__org_has_feature_pass_on_any_plan.sql`.

## 2. Decisions

Owner-decided during triage, 2026-08-05.

| Issue | Decision |
|---|---|
| 388 | Close with an evidence comment. Re-check the secondary ask it carried — whether the review panel's "N warnings to review" count covers every amber row now that `unschedulable` rows exist — and file separately if it is still wrong. |
| 389 | Close as mitigated by the `walletIds` scoping plus #390. No truncate work. |
| 382 | One PR: entitlement matrix **and** the owner addendum (rolling checkpoint eviction, AI-anchor pruning). |
| 383 | Do not auto-run. Render the existing `AiQuoteCard` at its flat 1-credit price; the organiser presses the button. |
| 384 | Seed the deterministic solver with `prior.assignments`. `prior.instruction` is ignored on the empty-instruction path — nothing is re-executed. |
| 385 | Resolve the weights and budget server-side and thread them to the cards as props. |
| 386 | New competition-scoped restore endpoint. One call restores every division named by the `schedule.applied_multi` event. |
| 387 | Inline receipt line naming both numbers, in both directions, **plus** a server-side telemetry event. |
| Order | C → B → (A ∥ D) → E. |
| Test bar | Unit + E2E + smoke + regression on everything **except** #391 and #392, which are docs/guard-only and ship unit + regression. |

### Why `prior.assignments`, not `prior.instruction` (#384)

`prior` carries two fields doing unrelated jobs, and conflating them is what
makes this issue read as scarier than it is.

```ts
// ai-console.tsx:906 — the officials adopt handler
prior = {
  instruction: state.officialsPriorInstruction,  // the PREVIOUS run's sentence
  assignments: patched,                          // the CURRENT grid, adoption swapped in
}
```

`prior.assignments` is not a stale instruction replayed. It is the grid on
screen with the organiser's chosen candidate substituted for one
(fixture, role) slot — data, produced by the click that just happened.

The fix reads that field in the solve. It does not re-execute
`prior.instruction`; on the empty-instruction path there is no instruction to
execute, which is the entire premise of that branch (zero LLM calls,
deterministic solver, flat 1-credit price).

Widening the fix to also stop `onAdopt` re-sending `prior.instruction` on the
**priced** path was considered and rejected for this pass. PR #359 left that
path alone deliberately; changing it here mixes an unrelated behavioural change
into a bug fix.

## 3. Groups

Grouping follows file overlap, not theme. Two groups may run in parallel only
when their file sets are provably disjoint — an ownership list is not evidence.

### C — board wiring (first, smallest)

**#394 — SUPERSEDED BY §8. This section's premise is wrong; it is kept only so
the correction has something to point at.**

It claimed: `schedule-board.tsx:596` passes `single ? divBoardFixtures :
actions.board` to `consoleFixtures`, and on a competition board `single` is null
so the joint console receives no fixtures.

The ternary takes the **false** branch when `single` is null. The competition
board gets `actions.board` — the whole board — and always has. There is no
production defect. See §8 for the mutation proof and for what the issue's
"dropping the ternary keeps tests green" evidence actually shows.

What shipped: the regression test only, in
`src/components/v2/__tests__/schedule-board-ai-wiring.test.tsx` (commit
`37ed6f45`). No change to `schedule-board.tsx`.

Files: its wiring test. Nothing else.

### B — joint apply/undo symmetry

**#386.** New `POST /api/v1/competitions/{id}/schedule/restore`, mirroring the
apply route's shape:

- read `division_ids` off the `schedule.applied_multi` competition event
- take every named division's advisory lock in **sorted division-id order** (the deadlock guard the apply already uses)
- assert each division's `seq`
- restore each to the watermark its anchor recorded
- one transaction, all divisions or none

The client's `undoJointApply` loop in `ai-joint-apply.ts` becomes one call.
The `failed[]` / `undonePartial` disclosure path stays in the code but should
become unreachable for the atomic case; keep it for the pre-existing per-division
restores.

**#392.** Guard the corrected sentence. `copy-truth.ts` already has the
machinery — `RETIRED_AI_RUN_CAP_PATTERNS` and the anchored token-ladder table
check are the precedents. Add a pattern list, a scoped call site, and a **fire
test proving the pattern can actually match**. The corpus check matters: an
empty corpus leaves the guard green while testing nothing, which is worse than
no guard because it reads as coverage.

**#391.** Add the joint limit to `apps/web/content/help/scheduling/ai-scheduling.md`,
in the "Two more limits worth knowing" block at `:187` (which becomes three).
The limit is `ai-plan-competition:${competitionId}` — **3/hour, keyed to the
competition, not the division** (`competition-schedule-ai.ts:1660`). The
asymmetry is the point: two divisions run jointly consume the competition
budget, not each division's, and the organiser gets a *tighter* limit than the
per-division 5/hour for doing the thing we recommend.

Files: new API route, `server/usecases/competition-schedule-*.ts`,
`components/v2/board/ai-joint-apply.ts`, `components/v2/board/ai-competition-console.tsx`,
`lib/copy-truth.ts`, the help article.

### A — quote/charge integrity (one implementer pass)

These four cannot be split: #385/#387 and #383/#384 both edit
`components/v2/board/ai-console.tsx` and the quote cards. Same files → one pass,
in this order.

**#385 first, because it is the cause.** `envNumber` at `ai-rung.ts:32` reads
`process.env[name]` with a **computed** key. Next substitutes `process.env.FOO`
statically and only for `NEXT_PUBLIC_`-prefixed names, so a computed lookup is
never replaced at all — in a `"use client"` module every call falls through to
its fallback. Sixteen values diverge across three functions
(`schedulingRungWeights`, `officialsRungWeights`, `tokenBudgetForCredits`), on
every quote surface including the joint N-line card where the error is
multiplied by the number of divisions selected.

Nothing sets these variables today (zero occurrences, zero in both `fly.toml`),
so there is no live defect — and that is exactly why it is worth fixing now.
The override mechanism exists to be used *in production without a deploy*; its
own doc comment says the budget cliff "can be loosened without a deploy while
the calibration data is still being gathered". The first calibration change
raises a price on the server while the card keeps quoting the default, and the
organiser is charged more than the confirm card promised.

Fix: resolve the effective weights and budget in a server component and pass
them to the cards as props. One source of truth, no per-keystroke fetch, and the
divergence becomes structurally impossible rather than merely absent.

Note for the implementer: this class of bug is invisible to the test suite by
construction — every suite runs server-side, where `process.env` works. A test
that only asserts the pure function is not evidence. Assert the **prop reaching
the card**, the way the #394 test asserts props reaching `AiCompetitionConsole`.

**#387 second, because it is the detector.** After a run returns, compare
`plan.credits` (`AiRunPriceFields`, `schemas.ts:1895`) to the quote the card
showed. Surface a named receipt line in both directions — over-quote is a bad
surprise, under-quote is a billing complaint, both must be visible — and emit a
server-side event so the divergence produces a signal even when nobody reads the
screen. #359 found three separate ways the same-function-same-inputs premise
breaks; each was caught by human review. A runtime comparison catches the fourth.

**#383 third.** Drop the auto-run in `ai-console.tsx`. The issue cites
`:580-585`; those line numbers have since moved, so locate the effect that fires
the officials draft on entering the officials step rather than trusting the
citation. Mount the
existing `AiQuoteCard` at single-line scale with `officialsRungWeights()`, as
this step's siblings already do, and let the organiser press the button.

The arithmetic is not the bug and must not change: `freeDraftQuote` returns
`credits: 1` — "free" means free of *model* cost, not free of charge — and three
tests lock that in, one of which forces rung 3 and still asserts a 1-credit
charge. Leave them alone.

**#384 last**, because #383 removes the state that makes it the common case.
`officials-ai.ts:901` seeds the deterministic solver from `pack.prior.assignments`
when present, falling back to `pack.locked`. The diff baseline at `:756` already
reads `pack.prior.assignments`, so after this change the two agree and the
"your own adoption was changed away" lie disappears without touching
`officialsDiff` at all.

Files: `lib/ai-rung.ts`, `components/v2/board/{ai-console,ai-quote-card,ai-officials-review}.tsx`,
`components/v2/board/ai-joint-run.ts`, `server/usecases/officials-ai.ts`, the
server components that mount the console, 4 locale dictionaries.

### D — billing cron (parallel with A)

**#390.** Anti-join the idempotency key so already-granted wallets never come
back from the sweep:

```sql
where not exists (
  select 1 from ai_credit_ledger
   where idempotency_key = 'monthly:' || s.id || ':' || ${period}
)
```

While in there, resolve the plan in the sweep — `orgPlanKey(row.rep_org_id)` at
`credits.ts:451` is one query per row, and the `plan_entitlements` lookup at
`:284` is another. That N+1 is the larger constant, and killing it is what makes
the zero-row day genuinely free.

Two correctness constraints that are not negotiable:

1. **The anti-join is a pre-filter, not a replacement.** Two overlapping runs
   could both pass it. The `pg_advisory_xact_lock` and the in-transaction
   `idempotency_key` check at `credits.ts:296-299` stay exactly as written.
   This change may only ever *reduce* the candidate set.
2. **`delta <= 0` returns before the key is written** (`:289`). A wallet whose
   plan grants zero never writes a key and re-qualifies every day forever.
   Harmless, but it means the anti-join alone does not reach zero rows — a
   second reason to resolve the plan in the sweep rather than per row.

The daily cadence stays. It is deliberate: retry after a failed run, no 28/29/30/31
or timezone edges, and it carries `checkEarnGrantVolumeAlert`, which needs a
genuinely daily poll. This makes the daily run cheap; it does not make it rarer.

The expiry path needs no handling — it runs inside the same transaction as the
grant (`:300-310`), so skipping an already-granted wallet cannot skip an expiry.

Files: `lib/credits.ts` and its tests. No i18n, no UI. Provably disjoint from A.

### E — entitlements and checkpoints (after A)

**Not** parallel with A: the checkpoint 402 surfaces in
`components/v2/board/ai-console-state.ts:466-470`, `ai-console.tsx:331` and
`ai-apply.ts:99` — all group A files. Both groups also add locale strings, and
`i18n:gen-keys` regenerates `lib/i18n-keys.ts`, which conflicts on any parallel
edit.

**#382, part 1 — the matrix.** `db/migration/deltas/V353__open_scheduling_entitlements.sql`
(not V344). `hasFeature` returns `row?.bool_value === true`, so a missing row is
false; Event Pass has **no rows at all** for board, constraints or
multi_division, which makes "multi-division for Pro and Event" an insert, not a
flip.

| feature | community | pro | pro_plus | event_pass | event_pass_l |
|---|---|---|---|---|---|
| `scheduling.ai` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `scheduling.board` | ✅ new | ✅ | ✅ | ✅ new | ✅ new |
| `scheduling.constraints` | ✅ new | ✅ | ✅ | ✅ new | ✅ new |
| `scheduling.multi_division` | ❌ | ✅ | ✅ | ✅ new | ✅ new |

`scheduling.multi_division` becomes the only scheduling paywall left.
`scheduling.ai` was already open to every plan — V322 retired
`scheduling.ai.runs_per_division.max` because the credit wallet meters runs on
every tier, so AI scheduling is credit-gated, not plan-gated.

No code change. The `requireFeature` calls at `schedule.ts:101`, `:491`, `:697`
stay as written and start passing. Conflict target is
`plan_entitlements_pkey (plan_key, feature_key)`.

**#382, part 2 — roll instead of refusing at the cap.** `createCheckpoint`
(`history.ts:339`) throws `PaymentRequiredError` (402) at
`schedule.checkpoints.max`. Community is **2** (V319 supersedes V290's 1).
Replace the refusal with a rolling window: drop the oldest manual save point,
insert the new one, name what went.

Eviction is cheap in a way worth stating in the code: a checkpoint is a named
bookmark, not the history. The ledger keeps every event and restore is "undo
until the watermark reaches this seq", so dropping a save point costs the label,
not the ability to rewind that far.

- `pro_plus` has a `null` limit (unlimited) — guard on `limit === null` before touching anything.
- If `n >= limit`, delete the `n - limit + 1` oldest, so the post-insert count is exactly `limit`. Do not assume `n === limit`.
- Eviction order `created_at asc, seq asc, id asc`. The UUID tie-break is normally forbidden by the determinism rule; it is acceptable here because this is *selection input*, not output ordering — same exemption as advisory-lock ordering. Say so in a comment or the next reader will "fix" it.
- Return what was evicted so the UI can name it. "An older save point was replaced" is not worth building.
- The 402 disappears for manual saves; the upgrade prompt survives as a non-blocking hint.

**#382, part 3 — prune AI anchors.** `kind: "ai"` anchors (V303) are exempt from
the quota and nothing ever deletes them. `superseded` is derived on read, not
stored, and the only `DELETE` is the user-initiated endpoint
(`history.ts:372`). Keep the newest **3** per division. Three rather than one
because the existing comment calls the deeper rewind out as deliberate — two
runs back plus the newest is exactly 3.

**#382, part 4 — a copy fix found during triage.** `openapi.ts:222` describes
the quota as "1 free / 5 Pro / unlimited Pro Plus". Community has been 2 since
V319. `V303__checkpoint_kind.sql:2` carries the same stale claim in a comment.
Correct both; the OpenAPI summary is published surface.

Files: `db/migration/deltas/V353__*.sql`, `server/usecases/history.ts`,
`server/api-v1/openapi.ts`, the checkpoint UI, 4 locale dictionaries.

## 4. Test bar

Every task ships all four unless named below:

- **Unit** — the specific function.
- **E2E (Playwright)** — the organiser-visible path.
- **Smoke** — the demo flow, updated for the feature.
- **Regression** — a test that fails without the change. Not negotiable; it is the standing project rule.

Exempt: **#391** (help article sentence) and **#392** (copy-truth guard) ship
unit + regression only. A Playwright run cannot meaningfully assert a markdown
paragraph, and #392's regression test *is* the fire test.

Traps that produce a false green here, all previously paid for in this repo:

- `rtk` vitest summaries print `PASS(0) FAIL(0)` for a suite that failed to collect. Judge green only from `--reporter=json --outputFile`.
- A worktree has no `.env.local`, so ~1772 DB tests skip with `total` unchanged — only `pending` moves.
- `npm test -- run <path>` treats positionals as filename filters; a typo runs a subset and reports green.
- E2E against `http://127.0.0.1:PORT` 401s every API call — the session cookie is `Secure` under `NODE_ENV=production`. Use `localhost`.
- A worktree's symlinked `node_modules` resolves `@seazn/engine` to **main's** engine. Check `readlink -f`.

## 5. Pre-commit gate

Two drift gates run on CI only, so a green local run proves nothing:

```
npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain   # must be empty
```

#386 adds an API route and #382 edits an OpenAPI summary, so both will drift
`openapi.ts` if regeneration is skipped. Groups A and E both add locale strings,
so both drift `lib/i18n-keys.ts`. This is the single most repeated CI failure on
this programme.

Also: `npm run lint` at the root does **not** cover `packages/engine`. None of
this work touches the engine, so that is informational only.

## 6. Execution order and parallelism

```
C  (#394)                 board wiring, smallest, unblocks nothing
     ↓
B  (#386, #392, #391)     joint undo symmetry + its copy guard
     ↓
A  (#385→#387→#383→#384)  ∥  D  (#390)     disjoint: board/officials vs lib/credits.ts
     ↓
E  (#382, all four parts)  after A — shares ai-console-state.ts and the locale dicts
```

Housekeeping, no branch needed: comment-and-close **#388** (with the "N warnings"
re-check) and **#389** (mitigated).

Agent topology per group: Implementer (Opus, high) → Reviewer (Sonnet) → gap
list → repeat until the review is clean and the gate is green. Scout (Sonnet)
for any read-only discovery. A and D run in separate worktrees; C, B and E run
sequentially in one.

## 7. Risks

| Risk | Mitigation |
|---|---|
| #385's fix is untestable in the failing direction — the suite runs server-side, where `process.env` works | Assert the prop reaching the card, not the pure function's return |
| #390's anti-join drops a wallet that should have been granted | The advisory lock and in-transaction key check stay; the anti-join may only shrink the candidate set. Test: a wallet with no key still qualifies; a wallet with one does not; two concurrent runs still grant once |
| #382 opens features to Community that were priced | Deliberate and owner-decided. `scheduling.multi_division` remains the paywall |
| #386's endpoint is new server surface with no caller until the UI lands | Ship the route and the usecase with tests in the same PR as the client switch, so it is never dead code |
| E's checkpoint eviction deletes a save point an organiser wanted | It costs the label, not the rewind — the ledger still reaches that watermark. The notice must name what went |

## 8. Correction: #394 is a phantom (2026-08-05)

`schedule-board.tsx:596` reads:

```tsx
consoleFixtures(single ? divBoardFixtures : actions.board, entrantNames, feedLabels)
```

`single` is null on a competition board, so the ternary takes the **false**
branch — `actions.board`, the whole board. The joint console has always
received every division's fixtures. Code and comment were written in the same
commit (`0f374d7a7`) and have never disagreed.

§1 of this document repeated the issue's misreading. Both were wrong about the
polarity, which is the entire content of the bug.

**Proven by mutation, not by inspection.** A regression test was written first
and came back green at HEAD (8/8). Mutating line 596 to
`consoleFixtures(divBoardFixtures, …)` — the shape #394 describes — turns it red
with `expected [] to deeply equal ['f1','f2',…]`, the reported symptom. So the
symptom is real *only* under a change nobody made.

The issue's supporting evidence was that dropping the ternary keeps
`src/components/v2` green. That observation is correct and its conclusion is
inverted: dropping the ternary changes the **division** board (widening it from
one division to the whole board) and no test notices. The finding is a coverage
gap on the division side, not a defect on the competition side.

Two further reasons the reported symptom cannot be this line:

- `ai-competition-console.tsx:697` renders `{f?.matchup ?? c.fixtureId.slice(0, 8)}`.
  A blocked row falls back to a truncated id, so it cannot render an empty
  label even when handed an empty fixture list.
- The full `src/components/v2` suite is 564/564 at HEAD with the ternary intact.

**Shipped:** the regression test only, as `37ed6f45` (`test:`, deliberately not
`fix:` — that message would record a fix that did not happen). No production
change.

**Lesson for the rest of this programme.** #394 is the fourth issue on this
label whose premise did not survive contact with the code, after #385
(`ai-joint-run.ts`), #386 ("one transaction"), and #382 (`V344`). Every one was
written during a review, citing the shape the reviewer expected rather than the
shape that exists. Write the failing test **first** and require it to go red
before touching production code — that is what caught this one.

# W4a — core time model: durations, elapsed-at-event, expiring penalties

Issue: [#425](https://github.com/ashokhein/seazn.club/issues/425). Follows W4
(#415, merged `fd452457`). Blocks W5 (#416) — a primitive the schema cannot
express by W5 cannot appear in a `PadSpec`, so W8's universal renderer cannot
draw it without reopening W8 and every W9 skin.

Scope is `packages/engine/**` only. No `apps/web`, no `openapi/*.json`, no
dictionaries, no `scoring-vocab.ts` (#427 is held until #400 merges).

---

## 1. The decision

**The engine models durations and elapsed-at-event. The pad owns the ticking.**

The ledger stays a record of facts with frozen timestamps. Replay stays
deterministic. A countdown becomes a pad rendering a duration against a known
start, not the engine racing wall-clock time. Ice hockey's "release a minor
early when a powerplay goal is scored" becomes a fold over recorded events
rather than a timer callback.

`core/clock.ts` keeps its existing contract unchanged: `Clock` is an adapter
seam for `recordedAt`, never consulted inside a fold. Nothing in this wave
gives the engine a live clock.

### 1.1 Time is stored as elapsed count-up within a period

```ts
at: { period: "P2", elapsed: 761 }   // 12:41 INTO P2
```

Integer seconds, counted up from the start of the named period. Rejected
alternatives and why:

- **As-recorded with a `basis: 'elapsed' | 'remaining'` flag.** Lossless, but
  two events in one match recorded on different bases are not comparable
  without the period length, and expiry arithmetic that crosses a period
  boundary then needs the length of both periods. Converting at the pad —
  where the period length is already known, because it is already drawing the
  clock — costs nothing and keeps one canonical form.
- **Absolute elapsed from first whistle.** Loses the period label every
  scoresheet in every one of these sports prints, and is ambiguous for
  overtime and shootout where period length varies or does not exist.

Seconds, not milliseconds: no scoresheet in any of the eleven sports records
sub-second time, and sub-second precision would make every frozen state string
larger for nothing.

### 1.2 Game clock, not wall clock

`elapsed` does not advance during a stoppage. This is the property that makes
the model correct rather than merely convenient: a minor started at `761`
expires at `881` whether or not an eight-minute injury delay intervened,
because IIHF penalty time only runs while play runs. Store wall time and every
expiry calculation would have to subtract accumulated stoppage back out.

The two durations a stoppage produces are already separately available:

| Question | Source |
|---|---|
| How much *game* time did the stoppage consume? | `resume.at − suspend.at` (zero in clock-stop sports) |
| How much *real* time did it consume? | envelope `recordedAt` delta |
| How long was the official allowed? | explicit `duration` on the interruption event (§5.4) |

Both `CoreSuspend` and `CoreResume` therefore carry `at?: GameTime` — optional
with no default, so every stoppage recorded before this wave still folds — and
the monotonic guard (§3.3) runs *above* the kernel's two `continue`s, so those
stamps are checked and counted like any other. Without both halves the
`resume.at − suspend.at` this table names is unrepresentable.

`core.suspend` and `core.resume` carrying the *same* `at` is correct, not a
bug, and gets a comment saying so — otherwise the first reviewer flags it. In a
clock-stop sport it is the normal reading, not an edge case.

### 1.3 `elapsed` may exceed the period length

Football's `90+3` is `{ period: "H2", elapsed: 2880 }` against a nominal 2700.
`periodSeconds` is a **soft bound** used for pad conversion and display only.
The fold never rejects an `elapsed` for being too large. A hard bound here
would reject every stoppage-time goal ever scored.

### 1.4 Where `at` lives: the payload, not the envelope

The envelope is the tidier home — one edit instead of one per payload, and the
core fold could read it generically. It is nevertheless **wrong here**, for a
reason specific to this repo:

`testkit/golden.ts:226` builds each corpus event as `{ type, payload }` and
discards the envelope. An envelope-borne `at` would therefore be invisible to
the golden corpus, invisible to `payloadParseFailures` (the additive-only
tripwire, `golden.ts:574`), and impossible for `arbitraryEvent` to generate
into an extended stream. The two mechanisms that prove this wave is additive
would both be blind to the field the wave exists to add.

So `at` is a payload field, added per sport, exactly as every other W4 field
(`emptyNet`, `reason`, `servedBy`, `minutes`) was.

The one generic consumer — the monotonic guard (§3.3) — reads it structurally
via a `gameTimeOf(payload)` helper that safe-parses and returns `null` for
anything that is not a `GameTime`. Core learns no payload shapes.

---

## 2. Core primitives — `packages/engine/src/core/time.ts`

New file, re-exported from `core/index.ts` alongside `clock.ts`. Zero runtime
dependencies; `zod` is already a peer.

```ts
/** Seconds. Non-negative integer. The engine's only unit of duration. */
export const DurationSeconds = z.number().int().nonnegative();

/** Elapsed-at-event: seconds counted UP from the start of `period`. */
export const GameTime = z.strictObject({
  period: z.string().min(1),
  elapsed: DurationSeconds,
});
export type GameTime = z.infer<typeof GameTime>;
```

Helpers, all pure. Three are deliberately **not total** — they throw rather than
coerce, because in each case the coerced value was silently wrong (an expiry at
the period start, a "period over" reading for an unknown period length) rather
than merely imprecise:

| Export | Behaviour |
|---|---|
| `compareGameTime(a, b, phaseOrder)` | `-1 \| 0 \| 1`. Phase index first, then `elapsed`. Throws `UNKNOWN_PHASE` for a period not in `phaseOrder`. |
| `addDuration(at, seconds)` | `{ period, elapsed: elapsed + seconds }`. Never rolls into the next period — see §3.2. Throws `INVALID_EVENT` for a negative or non-finite duration. |
| `remainingOf(at, periodSeconds)` | `max(0, periodSeconds − elapsed)`. Pad display. Throws `INVALID_EVENT` for a non-finite `periodSeconds`. |
| `formatElapsed(seconds)` | `"12:41"`, `"125:30"` past the hour. Minutes unbounded. |
| `parseElapsed(text)` | `"12:41" \| "1:05"` → seconds, else `null`. **`mm:ss` only** — see §4. |
| `gameTimeOf(payload)` | Structural safe-parse for the core guard. `GameTime \| null`. |

`formatElapsed`/`parseElapsed` are the migration path off free-text `clockRef`
(§5.1) and the input path for manual entry (§4).

---

## 3. Fold semantics

### 3.1 Expiry is lazy, at the next stamped event

A suspension carrying `startedAt` derives `expiresAt = addDuration(startedAt,
effectiveMinutes × 60)`. When any **later** event carrying `at` is applied, the
sport's `apply` first sweeps every active suspension whose `expiresAt` is at or
before that `at`, then applies the event.

The fold's state is only ever observed at event boundaries, so sweeping there
is sufficient. Between events the pad renders the countdown from `expiresAt`
itself. The pad and the fold will therefore *disagree* in the window between an
expiry and the next event — this is by design, and §6 makes it a `PadSpec`
requirement rather than a bug for W5 to discover.

Rejected: a `clock.tick` heartbeat event. It would expire penalties at exactly
the right instant, at the cost of putting cadence in the ledger — a 60-minute
match at 1 Hz is ~3600 extra events, and an irregular cadence (backgrounded
tab, flaky network) makes two replays of the same match diverge. Replay
determinism must not depend on something the scorer does not control.

### 3.2 Expiry does not cross a period boundary

`addDuration` stays within the named period. A minor awarded at `19:10` of a
20-minute period nominally runs into the next period, but the engine cannot
compute that without a period-length table it does not require (`periodSeconds`
is optional, §1.3). Such a suspension simply does not expire by time; it ends
on an explicit `suspension.end`, exactly as today.

This is a deliberate, documented limitation, recorded as a `deferred` dossier
row rather than half-solved. Promoting it needs `periodSeconds` to become
required, which is a product decision this wave does not force.

### 3.3 Stamps must not travel backwards

A timer only moves forward. A typed time (§4) can go anywhere, and an
out-of-order stamp makes lazy expiry silently wrong: a suspension started at
seq 4 / `05:00` would "expire" after one started at seq 3 / `08:00`.

New engine error **`NON_MONOTONIC_TIME`**, raised in `core/events.ts`'s fold
before dispatch, so all eleven modules inherit it from one place.

Two carve-outs, both load-bearing:

- **Equal `at` is legal.** `core.suspend`/`core.resume` share a stamp; so do
  two penalties at one whistle.
- **Unstamped events are unconstrained.** They neither advance nor are checked
  against the high-water mark.

Phase order comes from the module, via a new optional `playPhases?(cfg)` member
on `FoldableModule` — the same list the module passes to `compareGameTime`
inside `apply`, so the guard and the fold order against one list rather than
two. A period outside it is `UNKNOWN_PHASE`, checked on every stamp including
the first.

Where a module declares none, order is derived from first appearance in the
stream. That fallback exists only so an undeclared module behaves exactly as it
did before this wave, and it is **strictly weaker**: an unseen period is treated
as later than every period seen so far, so `P2 100` then `P1 50` — the commonest
manual-entry mistake there is — is accepted. Declaring `playPhases` is what
closes it.

### 3.4 Release-on-goal

`SuspensionClass` gains `releaseOnGoal?: boolean`. IIHF minors and bench minors
set it; majors, misconducts and match penalties do not. FIH cards do not (there
is no powerplay-goal release in hockey).

On a goal carrying `at`, the earliest running suspension of the **conceding**
side that is `teamShort`, `releaseOnGoal`, and carries `startedAt` is released.
"Earliest" is push order, which is start order.

Gated on both the goal and the suspension carrying time. That gate is what
keeps the eleven frozen goldens byte-identical: no recorded stream carries
`at`, so no stream releases anything it did not release before.

---

## 4. Manual time entry

The engine cannot distinguish a stamped time from a typed one — `at` is a value
on a payload, and who computed it is entirely the pad's business. Manual entry
is therefore a pad input mode, not an engine feature, and the majority of real
clubs will use it (paper sheet keyed in after the match; arena board read by
eye).

It has exactly three consequences for this spec:

1. **`periodSeconds` is required whenever the pad offers remaining-basis
   entry.** `07:19 remaining` cannot be converted to `elapsed 761` without it.
   Optional when the pad stamps from its own timer. Recorded as a `PadSpec`
   obligation for W5, not an engine constraint.
2. **`NON_MONOTONIC_TIME` (§3.3) exists because of it.** The timer path could
   never produce a backwards stamp.
3. **`parseElapsed` accepts `mm:ss` only, and the pad owns the unit.** A bare
   number is rejected. `"90"` as 90 seconds is a 60x hazard the moment a pad
   wires the helper to a minute box — and football's legacy field is literally
   named `minute` (§5.2), so that box exists. A pad offering minute-only entry
   multiplies by 60 itself, where the unit is unambiguous; a pad offering
   free-text entry formats to `mm:ss` first. Recorded as a `PadSpec` obligation
   for W5 alongside `periodSeconds`.

### 4.1 Correcting a stamp

Correcting a stamp uses the existing `voids` machinery on the envelope. No new
mechanism, and no carve-out in the guard — the two work together already,
because `resolveVoids` runs *before* the fold, so the high-water mark is
computed over **post-void order**, not append order. The mis-typed stamp is
simply not there to be beaten.

The order is void **then** re-append. The other order is a scorer asserting that
play went backwards while the mistake is still live, which is what the guard
exists to catch.

**The limit, and it is a real one.** A correction can only be re-appended behind
stamps that are themselves voided. Correcting the *newest* stamp works
directly; correcting an older one while later stamps are still live is rejected,
and should be — the fold applies events in append order, so a replacement
landing after `950` while carrying `600` would sweep lazy expiry (§3.1) against
an order nothing agrees on. The remedy is the one an undo stack produces
anyway: void back to the mistake, then re-append forward. Exempting events near
a void from the guard would reintroduce precisely the bug the guard exists to
prevent, so it is deliberately not done.

W5's pad obligation follows: an "edit this stamp" affordance on anything but the
newest stamped event must undo forward to it, not issue a lone void + append.

---

## 5. Where it lands, per sport

Thirteen deferred dossier rows across nine sports share this root cause. Each
lands additively; each moves its dossier row from `deferred` to `modelled` or
`extended` and updates the `**Row counts:**` tally that `testkit/dossiers.ts`
verifies.

### 5.1 Period kernel — hockey, ice hockey (`sports/period/kernel.ts`)

The largest landing. `clockRef` (free text, "display only", at `kernel.ts:191`,
`:200`, `:242`) is **not removed** — removing it would break both the frozen
goldens and the additive tripwire. It stays, deprecated in comment, and each
payload that carries it gains `at?: GameTime` beside it. Where both are present
`at` wins; where only `clockRef` is present the fold derives nothing, exactly
as today.

- `PeriodGoal`, `PeriodSuspensionStart`, `PeriodSetPiece` gain `at`.
- `PeriodSuspensionEnd` gains `at` (it had no `clockRef` — the end time was
  "an event, not a clock reading", which is precisely what `at` now records).
- `ActiveSuspension` gains `startedAt?` and `expiresAt?`; `GoalLogEntry` gains
  `at?`.
- `PeriodCfg` gains `periodSeconds?: Record<string, number>`, **optional with
  no default** — a defaulted field would appear in the cfg that is serialised
  into every frozen state string and break all eleven goldens at once.
- Sweep (§3.1) and release-on-goal (§3.4) run in `apply`.
- FIH's yellow-card duration picker (5 or 10) already works via the existing
  `SuspensionDetail.minutes` override; `expiresAt` now makes it *count down*
  the right amount rather than merely record it.
- The 8-second shoot-out clock (`meta.clockSeconds`) stays recorded, not
  enforced — it is a per-attempt limit, not a match clock, and enforcing it
  needs a `PadSpec` countdown W5 owns.

### 5.2 Football (`sports/football/football.ts`)

Football already carries a crude time: `minute?: number` on `FootballSub`
(`:124-129`), `FootballSinBinStart` (`:178-184`) and `FootballSinBinEnd`
(`:185-189`). It is football's `clockRef` — a display integer nothing folds on.
Same treatment: `minute?` stays, deprecated in comment, and `at?: GameTime`
lands beside it. Where both are present, `at` wins.

- Goal, card, sub and sin-bin payloads gain `at`.
- **Sin bin becomes a timed suspension.** Today `applySinBinStart`
  (`:561-603`) pushes a `SinBinRecord` into `squad.sinBin` that ends *only* via
  an explicit `football.sinbin.end` (`applySinBinEnd`, `:534-554`). With `at`
  plus the existing `cfg.sinBinMinutes` it expires by fold per §3.1. The
  explicit end event keeps working.
- **Substitution windows.** A "window" is a set of substitutions sharing one
  `at`. `cfg.maxSubs` already exists (`:27-78`); cfg gains only optional
  `subWindows`. State counts distinct stamped windows; exceeding either bound
  is a rejected event. Unstamped substitutions consume no window, which keeps
  every existing stream legal.

### 5.3 Set-based — table tennis (`sports/setbased/kernel.ts`)

The expedite system, per the product decision on #425.

- New `expedite.start` event (new event type — see §5.6), carrying **no game
  number**. ITTF Law 2.15.4: once introduced, expedite runs to the end of the
  *match*, not the end of the game. Scoping it per game would be wrong, and
  with no payload the second `expedite.start` is simply an invalid event. The
  ten-minute trigger stays the pad's; the engine records that it fired.
- `SetBasedRally` (`:93-98`) gains optional `returns: number` — the
  **receiver's good returns**, not the rally length. Law 2.15.2 awards the
  point on the receiver's thirteenth return. The two read identically in a
  schema and mean different things in a pad, so the field comment must say
  which.

**The receiver problem, and what it forces.** `SetBasedState` has **no serving
side** — grep for `serving` in `kernel.ts` returns nothing, and `payload.server`
(`:95`) is a `PersonId` used for one thing only: a `serves` tally in
`applyRally` (`:390-404`). Tennis's nested kernel does track `serving: Side`
(`nested/kernel.ts:221`); the set-based kernel deliberately does not.

So the engine cannot name the receiver from what it stores today. Three ways
out, and the cheap one is right:

- **Derive serving side from ITTF rotation** (change every 2 points, every 1 at
  10-all and under expedite). Real work, and it breaks on doubles order and
  mid-game lineup changes. Out of scope for a time-model wave.
- **Add `serving: Side` state to the set-based kernel.** A new state field on
  all three set-based sports to serve one rule in one of them.
- **Add optional `serving?: EntrantId` to the rally payload.** Additive, no new
  state, and the pad already knows who is serving because it is drawing the
  service indicator. Chosen.

`serving` is a **side**; the existing `server` is a **person**. Two adjacent,
similarly-named fields of different types on one payload is the exact shape
that produced the `DisciplineCard.entrantSide` bug, so this ships with a test
on a stream where the two disagree — a doubles rally whose `server` belongs to
the side that did *not* win. Without that case the confusion is invisible.

Enforcement is therefore conditional on the rally carrying `serving`: where
expedite is in force and `serving` is present, a rally with `returns >= 13`
crediting the serving side is rejected (`EXPEDITE_WRONG_WINNER`). Where
`serving` is absent, `returns` is recorded and the point stands uncontested.

Unconditional enforcement would reject legitimate coarse-tier rallies. The
conditionality is stated in the dossier row, not buried in the code.

### 5.4 Tennis / nested (`sports/nested/kernel.ts`)

`NestedEv` (`:191`) is `z.union([NestedPoint, NestedSetSummary, NestedSanction])`
— no interruption, timeout or retirement branch exists. Adding one is a new
event type (§5.6).

New `interruption` event: `kind` (`medical` / `toilet` / `heat` / `other`),
optional `person`, optional `duration: DurationSeconds`, optional `at`.

`duration` is recorded explicitly rather than derived from `recordedAt`,
because a three-minute medical-timeout limit must not drift when the umpire
taps late. Cfg gains optional per-kind allowances; exceeding a count allowance
is rejected, exceeding a duration allowance is **recorded, not rejected** — the
engine notes the overrun, the umpire adjudicates.

### 5.5 Boardgame, carrom, generic

`BoardgameCfg` **already has** `clock?: { base, increment }` (`:37-49`), held as
metadata with no enforcement (chess.md §2). The dossier gap is narrower than it
reads: what is missing is the *delay-vs-increment* distinction, not a time
control.

So this is a one-field extension of the existing object — `clock.delay?` — not
a parallel `timeControl`. Still metadata, still unenforced; the engine records
which time control was in force so a `PadSpec` can drive the right countdown.
Per-move clocks stay out of the engine.

Generic's `DOMAIN.md:58` boundary statement ("the engine owns no clock") is
amended to state the split precisely rather than deleted.

### 5.6 Two new event types = ten coordinated edits

`expedite.start` (§5.3) and `interruption` (§5.4) are new event **types**, and
in this engine each one is five coordinated edits, not one:

1. the union branch (appended **last** — §8),
2. the `apply` case,
3. `summary`,
4. `fidelityTiers`,
5. `arbitraryEvent`,

plus `playerStats` where the event carries person credit (`interruption` does,
via `person`; `expedite.start` does not). Miss one and the event validates but
never appears in a generated stream, a summary or a tier — which the golden
corpus will not catch, because it only replays what was recorded.

---

## 6. What W5 inherits

Four obligations recorded here so `PadSpec` (#416) does not have to rediscover
them:

1. A pad that offers remaining-basis manual entry **must** declare
   `periodSeconds` (§4). `remainingOf` throws rather than pretending an unknown
   period length is a finished period.
2. A pad **must** convert to seconds itself for any minute-basis input;
   `parseElapsed` takes `mm:ss` only (§4).
3. A pad rendering a countdown **must** show what the fold is folded *as of*
   (`asOf`), because the pad and the fold legitimately disagree between an
   expiry and the next event (§3.1). Without it a scorer reads a stale strength
   chip as a bug.
4. A pad **must** submit stamps in non-decreasing order or handle
   `NON_MONOTONIC_TIME` (§3.3). Correcting a stamp is void + re-append, in that
   order (§4).

Working models, both implementing the proposed fold for real:

- Time model, expiry and the monotonic guard —
  `claude.ai/code/artifact/b50b2720-b140-49d5-8aa1-4937e6b14ea0`
- Table tennis expedite and its conditional enforcement —
  `claude.ai/code/artifact/4ee6ddfb-9235-49f8-85e5-16924449a6ae`

---

## 7. Errors

Four literals appended to the `EngineErrorCode` enum (`core/errors.ts:7-28`,
13 codes today); thrown as `new EngineError(code, message, data)` per the
`invalid()` / `wrongPhase()` helpers at `football.ts:281,285`.

| Code | Raised when |
|---|---|
| `NON_MONOTONIC_TIME` | A stamped event's `at` precedes the newest accepted stamp (§3.3). |
| `UNKNOWN_PHASE` | `compareGameTime` receives a period absent from `phaseOrder`. Phase order comes from `playPhases` (`period/kernel.ts:366-368`). |
| `EXPEDITE_WRONG_WINNER` | Expedite in force, `serving` recorded, `returns >= 13`, point credited to the serving side (§5.3). |
| `SUB_WINDOW_EXCEEDED` | Football substitution beyond `subWindows` or the existing `cfg.maxSubs` (§5.2). |

---

## 8. Additive-safety contract

Non-negotiable, and each item is a test rather than an assertion:

- **Never run `UPDATE_GOLDEN=1`.** A red golden means the change was not
  additive; fix the change. Corpora extend append-only via `EXTEND_GOLDEN`,
  with the existing prefix verified byte-identical.
- Every new payload field is `.optional()` with **no default**.
- Every new cfg field is `.optional()` with **no default** — cfg is serialised
  into the frozen state strings.
- Every new state field is absent until something populates it, matching the
  `goalLog` / `setPieces` precedent (`kernel.ts:307-311`).
- All eleven modules stay at `1.0.0`. `registry.get` is an exact lookup and
  there is no production data to protect.
- `packages/engine` keeps zero runtime dependencies; nothing re-exported from
  `testkit/index.ts` may import `node:fs`.

### Union-swallow hazard

`PeriodEv` is a `z.union` matched structurally, first branch wins
(`kernel.ts:245-257`). Widening `PeriodGoal` — branch one — with an optional
`at` widens the branch most able to swallow its siblings. Every payload shape
in the union ships a disambiguation test asserting it parses to *its own*
branch, not merely that it parses. The same applies to `SetBasedEv`,
`NestedEv`, `FootballEv` and `BoardgameEv`.

---

## 9. Testing

Every change ships a test that fails without it.

| Layer | What it covers |
|---|---|
| **Unit** | `core/time.ts` helpers: compare across phases, `addDuration` staying in-period, format/parse round-trip, `gameTimeOf` rejecting non-`GameTime`. |
| **Unit** | Sweep: expiry at, before and after the boundary; expiry that would cross a period (must NOT expire, §3.2). |
| **Unit** | Release-on-goal: releasable vs not, conceding vs scoring side, earliest-first with two running, no release when either side of the pair lacks time. |
| **Unit** | Monotonic guard: backwards rejected, equal accepted, unstamped interleaved freely, guard skipped entirely for unstamped streams. |
| **Regression** | A stream with **no** `at` anywhere folds to a byte-identical state before and after this wave — the additive proof at fold level, independent of the goldens. |
| **Golden** | All eleven `<key>.golden.json` byte-identical, no re-baseline. New coverage lands as appended streams with the prefix verified. |
| **Conformance** | Existing cross-sport invariants stay green; `arbitraryEvent` emits `at` for the new fields so property runs exercise them. |
| **Dossier** | `testkit/dossiers.test.ts` — every touched row moves off `deferred` and the `**Row counts:**` tally matches. |
| **Disambiguation** | Per §8, one test per union per payload shape. |
| **New-type completeness** | For `expedite.start` and `interruption`: assert each appears in `fidelityTiers`, is reachable from `arbitraryEvent`, and changes `summary` — the three of the five edits (§5.6) that fail silently. |
| **Smoke** | `scripts/smoke.ts` extended: a timed hockey match where a minor expires and a powerplay goal releases another. |
| **e2e** | Deferred to W10 (#421), where the pad first meets the API. This wave ships no `apps/web` surface, so there is nothing to drive. Recorded here so its absence is a decision, not an oversight. |

Gate, run from the worktree in a single call, no positional (a positional is a
filename filter that silently runs a subset):

```
cd <abs worktree>/packages/engine && npx vitest run \
  --reporter=json --outputFile=<abs>/after.json
```

Baseline to beat: **1512 passed / 0 failed / 405 suites** (verified on
`origin/main` at `fd452457` before any change). Judge green only from
`numPassedTests` / `numFailedTests`, and confirm the resolved paths in
`.testResults[].name` point at the worktree — shell cwd resets to the main
checkout between calls and will false-green.

---

## 10. Out of scope

- Any `apps/web` surface, `openapi/*.json`, dictionaries or `scoring-vocab.ts`
  (#427, held until #400 merges). Labels for the new events are #427's.
- Persisting `at` — the events table gains no column this wave. The engine
  accepts the field; wiring it through the API is W10 (#421).
- Mutable squads / lineup events — #426, the next wave.
- Expiry across a period boundary (§3.2).
- Enforcing the FIH 8-second shoot-out clock (§5.1).
- Per-move board clocks (§5.5).

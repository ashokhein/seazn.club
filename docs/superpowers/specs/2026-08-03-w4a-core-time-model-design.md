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

The two durations a stoppage produces come from different places, and each is
answerable without re-scanning the raw ledger:

| Question | Source |
|---|---|
| How much *game* time did the stoppage consume? | `resume.at − suspend.at` (zero in clock-stop sports) |
| How much *real* time did it consume? | envelope `recordedAt` delta |
| How long was the official allowed? | explicit `duration` on the interruption event (§5.4) |

`suspend.at` is the half only the fold knows, so **`MatchStoppage` carries
`at?: GameTime`** — the stamp the monotonic guard accepted on the `core.suspend`
that opened the stoppage, absent when the pad recorded none. Without it the
first row of that table was not derivable from the fold's OUTPUT at all: a
consumer had to go back to the stream and find the event by `eventId`, which is
the work folding exists to spare it. With it, a pad renders "suspended at P2
12:41" from the fold alone and differences it against the `core.resume` it is
about to append.

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

### 3.2 Expiry carries across a period boundary

**Amended 2026-08-04.** This section originally said expiry never crosses a
boundary, on the reasoning that the engine had no period-length table. Both
halves were wrong, and the review that found it is the reason this reads the
way it does now.

The rule does not exist in either sport's laws. IIHF carries an unserved
penalty into the next period; IFAB's temporary-dismissal protocol carries the
unserved remainder of a sin bin into the next half in exactly the same way. A
minor awarded at `19:10` of a 20-minute period **runs into the next period**,
and a fold that ends it at the whistle under-serves it — which is worse than
not modelling expiry at all, because it is silently wrong in the sport's
favour rather than visibly incomplete.

Nor is the length missing. `cfg.periods.minutes` and `cfg.overtime.minutes`
are already **required** positive integers, and every phase the expiry walk
can reach is `periodLabels + otLabels`. Verified across all five shipped
variants: ice/iihf P1–P3 = 1200, OT = 300; ice/recreational P1–P3 = 1200, no
OT; fih-outdoor and fih-shootout Q1–Q4 = 900; fih/youth Q1–Q4 = 600. The gap
list for the carry is **empty**.

So: derive the period length from cfg inside the expiry walk — never as a zod
`.default()`, which would change every serialised golden state string.
`cfg.periodSeconds` stays as an **override for the one thing cfg cannot
express**: unequal period lengths, since `periods.minutes` is a single scalar
for all n and `overtime{kind:"periods"}.minutes` a single scalar for OT1..OTk.

A `periodSeconds` map that contradicts its cfg source is **ignored, not
refused** — the required scalar wins. Refusing would mean a `CONFIG_INVALID`
raised on the replay path, and cfg is read live from `division.config` on
every read, so a later admin config edit would make every already-scored
fixture in the division permanently unviewable. Same reasoning as the
never-throws rule on the sweep itself.

**The fallback, named rather than assumed:** where no length is derivable for
a phase, the expiry stays in-period and the suspension ends on an explicit
`suspension.end`. That is a fallback for an unreachable case, not the rule.

`addDuration` itself is unchanged: it is a primitive over one period and never
rolls forward. The carry lives in the expiry walk, which advances phase by
phase using `playPhases` (§7).

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
two. §7 makes that an obligation with a test behind it, not a convention.

**A period outside the declared list is `INVALID_EVENT`**, checked on every
stamp including the first. It is payload validation, not an invariant breach:
`at.period` is a free `z.string().min(1)` the client supplies, so the
overwhelmingly likely cause is a scorer picking a period this sport does not
have, and the error names the ones it does so the pad can say "retype it".
Raising `UNKNOWN_PHASE` here made a typo a captured 500 that paged the on-call
and told the scorer nothing (`ENGINE_HTTP`, `api-v1/http.ts`). `UNKNOWN_PHASE`
is left to mean what §7 says it means: two phase lists that disagree.

**The declared list is exhaustive by OBLIGATION, not by construction.** Nothing
about the type makes it so — the first draft wired the period kernel's existing
`playPhases` (regulation + overtime), which omits both `pre` and `SHOOTOUT`
even though cards are legal in each, and every stamped shootout card would have
been refused. A module must list every phase in which a stamped event may
legally occur, in the order they occur, and nothing more (`done` is excluded:
nothing stamped is accepted once the match is decided). Anything omitted is an
event the scorer cannot record.

Two degenerate declarations are refused outright, at fold start, as
`CONFIG_INVALID` — both are facts about the module and its cfg, knowable before
the first event and wrong for every event after it:

- **Empty.** Read as "declares nothing" it silently drops the sport onto the
  weaker derived order below, for precisely the cfg whose list came out empty;
  read as declared-and-exhaustive it refused every stamped event in the sport.
  Both readings hide a module bug.
- **Duplicated.** `compareGameTime` orders by `indexOf`, so the repeat is
  orphaned: two phases the module says are distinct sort as one, and every
  comparison against the orphan is quietly wrong with nothing in the state or
  the goldens to show it.

Where a module declares none, order is derived from first appearance in the
stream. That fallback exists only so an undeclared module behaves exactly as it
did before this wave, and it is **strictly weaker**: an unseen period is treated
as later than every period seen so far, so `P2 100` then `P1 50` — the commonest
manual-entry mistake there is — is accepted. Declaring `playPhases` is what
closes it.

### 3.3.1 Strict on write, tolerant on replay — ADDED 2026-08-04 (T9)

Everything in §3.3 above is stated as though the fold had a write path. It did
not. `foldMatch` is the only state-derivation function AND the write gate:
`append-event.ts` validates a candidate by folding the whole stream including
it, through the same fold, against a `cfg` it rebuilds live from
`division.config` on every call. Two consequences compose:

1. every check ran identically on write and on read, so "refuse this on the
   write path only" was not expressible; and
2. every READ replays from `init`, so a refusal computed from cfg fires on
   events **already in the ledger** the moment an organiser edits the config —
   with no event to void and no scorer action that recovers the fixture.

The phase guard §3.3 specifies is exactly that shape, one layer above all
eleven sports: its own justification ("a scorer picking a period this sport does
not have") is a statement about a NEW event and false about history.

**`FoldOptions.strictFromSeq`** is the seam. It is the seq of the first event
not yet in the ledger: events at or after it are validated in full, everything
before is replayed. One fold, one traversal. `append-event.ts` passes the
candidate's seq — exactly one strict event; `fold.ts` and every other read path
pass nothing.

**Absent means tolerant**, and that polarity is the fail-safe one: a caller that
forgets the option under-validates a write it was probably not making, where the
opposite default bricks every fixture in an edited division. The seam reaches
modules too, via an optional third argument to `apply` (`FoldContext`); absent
there reads as STRICT, because the only callers that omit it are the testkit
harnesses building a stream event by event.

**The rule this gives the whole engine:** a check whose verdict a config edit
can move is strict-only. A check that reads the stream alone — payload schema,
a tie-break winner contradicting its set winner, a lineup membership — is
unconditional. `docs`-level consequence: "X is rejected" in this spec now always
means *rejected on append*, and a recorded stream must remain readable under any
config the schema accepts.

**One class is knowingly outside it.** Lowering `bestOf`, `maxBoards`,
`periods.count` or `playersPerSide` decides a recorded match EARLIER on replay,
and guarantee 4 (`ALREADY_DECIDED`) then refuses the rest of the ledger. Gating
guarantee 4 on the seam was tried and reverted: it moves the throw one layer
down into each module's own terminal-phase guard, so a real fix is a coordinated
ruling across the kernel and all eleven modules on what a post-decision event
MEANS on replay — dispatch it and the state is nonsense, skip it and the fold
silently drops recorded history. `sports/cfg-replay.conformance.test.ts`
classifies that class exhaustively and names the sports that exhibit it, so both
a new brick and a fix turn it red.

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
- Sweep (§3.1) and release-on-goal (§3.4) run in `apply`, ordering against
  `playPhases(cfg)` — the exported function the module already hands the fold
  (§7 obligation 3). Not a locally built list, and not the private
  `scoringPhases`, which is regulation + overtime only and exists solely to
  answer "is play running?" (`isPlayPhase`).
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
taps late. Cfg gains optional per-kind allowances.

**AMENDED 2026-08-04 (T9).** This paragraph said "exceeding a count allowance is
rejected, exceeding a duration allowance is recorded". What shipped is
`overCount: true` alongside `overran: true` — **neither allowance refuses**, and
this amendment makes the spec say what ships.

It was first departed from as a bug fix. Both allowances are computed from a cfg
read live out of `division.config`, and every read replays the whole stream from
`init`, so refusing on `count` fired on events already in the ledger the moment
an organiser lowered the number — with no event to void and no scorer action
that recovers the fixture. At the time there was no way to say "refuse this only
when it is being appended", so recording a flag was the only option.

**§3.3.1 has since built that seam, and the answer is still no.** With
`strictFromSeq` a count refusal *could* now be strict-only. It should not be,
for three reasons that are about the rule rather than the mechanism:

1. **The break happened.** The chair keys it in because a physio came on court.
   Refusing the event does not send the physio away; it destroys the only record
   that the fourth medical timeout occurred, which is precisely what an appeal
   needs. That is the argument this section already made for `duration`, and
   nothing about `count` distinguishes it.
2. **One rule, one mechanism.** Enforcing the two halves of the same cfg object
   by two different means — one refusal, one flag — is a difference a reader
   would look for a reason behind, and there is none.
3. **A refusal is user-facing copy.** `EngineError.message` reaches the scorer
   verbatim, so refusing here means telling an umpire mid-match that something
   they watched happen is not allowed to be recorded.

So the seam changes the *reason* rather than the verdict: `overCount` was a
workaround for a missing capability and is now a deliberate rule. The engine
notes both verdicts; the umpire adjudicates.

The interruption's `at` handling follows §3.3.1 in full — the two phase checks
and the "stamped ahead of play" comparison are **strict only**, because
`playPhases` is derived from `bestOf` and lowering it from 5 to 3 would
otherwise make every interruption recorded in S4 or S5 unreadable.

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
| `UNKNOWN_PHASE` | `compareGameTime` (`core/time.ts`) receives a period absent from the `phaseOrder` it was handed. **Two call paths reach it** and both must be named: a module's own comparisons inside `apply()` (the sweep, release-on-goal), and the fold kernel's monotonic guard comparing a stamp against the high-water mark. It always means two lists disagree — a client's unrecognised period is refused earlier, as `INVALID_EVENT` (§3.3). |
| `INVALID_EVENT` | Among the existing causes: a stamp naming a period the module does not declare (§3.3). |
| `CONFIG_INVALID` | Among the existing causes: a module declaring an empty or duplicated phase order (§3.3). |
| `EXPEDITE_WRONG_WINNER` | Expedite in force, `serving` recorded, `returns >= 13`, point credited to the serving side (§5.3). |
| `SUB_WINDOW_EXCEEDED` | Football substitution beyond `subWindows` or the existing `cfg.maxSubs` (§5.2). |

All four new codes map to **422**, `UNKNOWN_PHASE` included. It rejects one
event; a 500 pages the on-call and gives the scorer nothing to act on.

### The phase-order obligation — every sport that lands `at`

The guard's list and the list `apply()` orders against must not merely be
equal, they must be **the same function**. Two lists that agree today is round
1's defect one layer down: an event the guard accepts is backwards inside
`apply`, and lazy expiry (§3.1) sweeps against an order nothing agrees on.

A sport landing `at` therefore owes four things:

1. **One exported function** in the sport's own file returning the phase order
   for a cfg — `playPhases(cfg)` in `sports/period/kernel.ts` is the reference
   implementation. It covers every phase a stamp may name, including the ones
   where play is not running, and orders the shootout after any overtime.
2. **The module declares that function itself**, `playPhases,` — not a wrapper,
   not a copy of its output.
3. **Every `compareGameTime` call inside `apply()` passes that same function's
   result.** No locally built list, however obviously equal.
4. **A per-sport test asserting the reference**, i.e. `expect(mod.playPhases)
   .toBe(playPhases)`, which fails if the two are ever wired separately. Assert
   both sides are functions first: `undefined === undefined` passes a bare
   `toBe` and pins nothing. See `sports/period/phases.test.ts`.

---

## 8. Additive-safety contract

Non-negotiable, and each item is a test rather than an assertion:

- **Never run `UPDATE_GOLDEN=1`.** A red golden means the change was not
  additive; fix the change. Corpora extend append-only via `EXTEND_GOLDEN`,
  with the existing prefix verified byte-identical.
- Every new payload field is `.optional()` with **no default**.
- **Any payload gaining `at` uses the `GameTime` schema VERBATIM** —
  `at: GameTime.optional()`, never a hand-rolled `z.object({ period, elapsed })`
  that happens to look like it. This is a contract, not a style note, because
  the kernel is deliberately fail-OPEN on a malformed stamp: `gameTimeOf` is a
  structural safe-parse, so `{ period: "P1", elapsed: -1 }` returns `null` and
  the monotonic guard treats the event as *unstamped* rather than rejecting it
  (`events.time.test.ts` pins that). The payload's own schema is therefore the
  only thing standing between a corrupt stamp and the ledger, and only the real
  `GameTime` carries all four of its guards: non-negative, integer, non-empty
  period label, and strict (an unknown key is not a widened `GameTime`).
  `CoreSuspend` / `CoreResume` are the pattern to copy.
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
| **Unit** | Sweep: expiry at, before and after the boundary; expiry that crosses a period (must carry the unserved remainder into the next phase, §3.2); the named in-period fallback where no length is derivable; a contradicting `periodSeconds` ignored rather than refused. |
| **Unit** | Release-on-goal: releasable vs not, conceding vs scoring side, earliest-first with two running, no release when either side of the pair lacks time. |
| **Unit** | Monotonic guard: backwards rejected, equal accepted, unstamped interleaved freely, guard skipped entirely for unstamped streams. |
| **Unit** | Phase order: an undeclared period is `INVALID_EVENT` and names the valid phases; an empty and a duplicated declaration are each `CONFIG_INVALID` at fold start. |
| **Per-sport** | The module's `playPhases` **is** the sport's exported phase-order function (reference identity, §7 obligation 4), and the list it returns covers `pre` and `SHOOTOUT` with the shootout last. |
| **Regression** | A stream with **no** `at` anywhere folds to a byte-identical state before and after this wave — the additive proof at fold level, independent of the goldens. |
| **Golden** | All eleven `<key>.golden.json` byte-identical, no re-baseline. New coverage lands as appended streams with the prefix verified. **`keepRecordedCfg`, stated precisely** (an earlier draft of this row overstated it): the comparison is a SUBSET rule, so an *added* cfg key is tolerated — which is what makes an additive cfg change land at all, and it cannot be tightened without re-breaking W4 item 5. A *changed value on a recorded key still reds*, and a re-baseline does not launder that: it can hold a red open, never close one. So the blind spot is exactly one shape — a cfg key that appears where none was before. Pinned by three tests at the assertion site. |
| **Conformance** | Existing cross-sport invariants stay green; `arbitraryEvent` emits `at` for the new fields so property runs exercise them. |
| **Dossier** | `testkit/dossiers.test.ts` — every touched row moves off `deferred` and the `**Row counts:**` tally matches. |
| **Disambiguation** | Per §8, one test per union per payload shape — and it must pin **which branch won**, not merely that the payload round-trips. Four shapes that pin nothing were shipped and caught in review this wave: (1) `toEqual(payload)` against a `strictObject` union — zod returns the input unchanged, so it passes on any winning branch; (2) a hand-ordered local `BRANCHES` copy, so reordering the real union reds nothing — filter the real `…Ev.options` instead; (3) asserting `code: "INVALID_EVENT"` alone, which is thrown by `apply`'s `default:`, by every `parsePayload` failure and by `sideOf` — match on `message`; (4) a metric's `when` predicate asserted only by the metric's existence. Assert the losing branches **reject**. |
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
- ~~Expiry across a period boundary~~ — **no longer out of scope.** §3.2 was
  amended 2026-08-04: the carry is in, because the rule that justified deferring
  it does not exist in either sport's laws and the period lengths were already
  required cfg. Kept here struck through so the reversal is visible rather than
  quietly dropped.
- Enforcing the FIH 8-second shoot-out clock (§5.1).
- Per-move board clocks (§5.5).

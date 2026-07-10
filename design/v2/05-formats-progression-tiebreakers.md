# 05 — Formats, Progression & Tiebreakers

The competition engine's normative spec. Sport-agnostic: it consumes `MatchOutcome`,
`StandingsDelta` and `MetricSpec`s from sport modules (doc 04) and produces fixtures,
tables, and qualification.

## 1. Stage kinds

| kind | generation | completion | ranking |
|------|-----------|------------|---------|
| `league` | circle-method RR × legs | all fixtures decided/void | full cascade table |
| `group` | K pools, RR inside each | all pools complete | per-pool tables + cross-pool comparison rules |
| `swiss` | round-by-round pairing | N rounds played | score + swiss metrics |
| `knockout` | seeded SE bracket | final decided | bracket position (+ 3rd-place playoff opt) |
| `double_elim` | winners+losers brackets | grand final decided | bracket position |
| `stepladder` | rank-ordered ladder (v1 `progress_stepladder`) | ladder final decided | ladder position |

Stage config (all kinds): `{ legs?: 1|2, pools?: {count, size?, assignment: seeded_snake|random_seeded|manual},
rounds?, bracketSize?, thirdPlace?, seeding: SeedingPolicy, rngSeed }`.

## 2. Fixture generation algorithms

### 2.1 Round robin — circle method
N entrants (pad with BYE if odd). Fix entrant 0; rotate 1..N−1 each round. N−1 rounds,
N/2 fixtures/round; every pair meets exactly once per leg. Legs=2 mirrors home/away.
Properties asserted in tests: completeness `n(n−1)/2·legs`, one fixture per entrant per
round, home/away balance |home−away| ≤ 1 per entrant per leg. (Circle method is also
maximal-carryover — acceptable at our scale; note for future "balanced carryover" option.)

Ordering within a round: rotate board/court assignment so no entrant monopolises court 1.

### 2.2 Swiss pairing (chess-correct, sport-generic)
Per round, on current standings:
1. Group entrants by score (score groups, descending).
2. Within each group order by pairing rank (rating/seed, then cascade).
3. Fold top half vs bottom half (FIDE Dutch heuristic); resolve violations by transposition:
   - **No rematch** (hard).
   - **Colour/side rules** (chess only, via module flag): no 3 consecutive same colour,
     |W−B| ≤ 2; prefer alternation (soft, then hard at limits).
   - Odd group ⇒ float lowest-ranked to next group (track float history, avoid repeat floats).
4. Odd total ⇒ bye to the lowest-ranked entrant not yet byed; bye scores `cfg.byeScore`.

Implementation: backtracking over transpositions within score groups is sufficient and
matches how real arbiters operate; full FIDE Dutch (2026 edition) via weighted matching is
a later refinement — keep the pairing function behind an interface (`pairRound(standings,
history, constraints) → Pairing[]`) so the algorithm can be swapped without touching callers.
Determinism: all ties inside the algorithm break by pairing rank, then seeded rng.

### 2.3 Knockout bracket — seeding & byes
Bracket size `S = nextPowerOfTwo(entrants)`. Standard fold placement: seed positions so
1 meets 2 only in the final, 1v4/2v3 semis, etc. (recursive interleave: `[1,2]` →
`[1,4,3,2]` → `[1,8,5,4,3,6,7,2]`). Byes = `S − n`, awarded to top seeds (their round-1
fixtures auto-decide as `award`). Feeds: fixture (r,i) winner → (r+1, ⌊i/2⌋) slot `i mod 2`.
Optional 3rd-place playoff from semifinal losers. Cross-pool seeding template for
group→KO: A1–B2, B1–A2 pattern generalised: winners face runners-up of another pool,
same-pool rematch deferred to latest possible round. (PROMPT-09: implemented as a
rank-interleave of pool finishers fed into the fold — exact for two pools; for k>2 pools
it defers same-pool rematches only as far as the fold allows, full latest-round deferral
is a later refinement.)

### 2.4 Double elimination
Winners bracket = SE bracket; each WB round's losers drop into the losers bracket at the
canonical slot (LB alternates "minor" rounds absorbing WB losers and "major" rounds).
Grand final: WB champion vs LB champion; **bracket reset** optional (LB champ must win
twice) via config. Feeds encoded the same `winner_to/loser_to` way — the engine's fixture
wiring is uniform across SE/DE/stepladder. (PROMPT-09: the reset decider is generated as a
`conditional` grand-final fixture fed by GF1's winner/loser; the persistence adapter voids
it when the WB champion wins GF1, and void counts as settled for stage completion.)

### 2.5 Stepladder (v1 compatibility)
Rank R4 v R3 → winner v R2 → winner v R1 (final). Generalised to size k.

### 2.6 Calendar slotting (scheduling pass, separate from generation)
Pure constraint pass mapping generated fixtures → (datetime, venue/court): inputs
`{startAt, matchMinutes, gapMinutes, courts[], perEntrantMinRest, blackouts[]}`; greedy
round-order assignment with rest checking; conflicts reported, not silently fixed.
Organiser can hand-edit; engine only validates. (Traveling-tournament optimisation is
explicitly out of scope.) Product flow on top of this pass — quick-start vs plan-first,
drag-and-drop board, locked assignments — in [12-scheduling-ux.md](12-scheduling-ux.md).

## 3. Progression & qualification

Stage completion fires `resolveQualification(nextStage.qualification)`:
```ts
qualification: { from: stageId, take: [{pool: 'A', rank: 1}, {pool: 'B', rank: 1}, ...] |
                 { topN: 8 } | { bestOfRank: {rank: 3, count: 2} } }   // "two best third-placed"
```
"Best third-placed" comparison across pools of unequal size: normalise by dropping results
vs the lowest-ranked pool member (UEFA method) — config flag; default simple metric
comparison. Output = ordered seed list → next stage's generator. Idempotent: re-running
with identical inputs yields identical fixtures (deterministic generators + stored rngSeed).

**Ranks must be final before qualification:** if the cascade exhausts and `lots` decides,
the engine emits a `rank_lock_required` division event — organiser confirms the seeded-rng
lot draw (audited) before the next stage generates. Never silently randomise progression.

## 4. Tiebreaker cascade engine

### 4.1 Design
A standings table = entrants sorted by a **cascade of comparators**. Cascade is data:

```ts
type TiebreakerKey = 'points' | 'wins' | 'h2h_points' | 'h2h_diff' | 'h2h_for'
  | 'diff' | 'for' | 'nrr' | 'set_ratio' | 'point_ratio' | 'buchholz' | 'buchholz_cut1'
  | 'sberger' | 'direct' | 'fair_play' | 'seed' | 'lots';
Comparator = (a: Row, b: Row, ctx: {fixturesAmong(tied): Outcome[]}) => number;
```

Registry maps keys → comparators; sport module supplies `defaultTiebreakers`; division
config may override (validated: only keys whose metrics the sport maintains).

### 4.2 Head-to-head sub-table semantics (the part everyone gets wrong)
`h2h_*` comparators operate on the **set of tied entrants**, not pairwise:
1. Partition current tie-group; build a mini-table from fixtures *among tied entrants only*.
2. Apply `h2h_points`, `h2h_diff`, `h2h_for` **within that mini-table**.
3. If the mini-table splits the group partially, **re-run the mini-table cascade on the
   remaining sub-tie** (UEFA recursive re-application) — config flag `h2hRecursive`
   (UEFA: true; FIFA 2026: falls through to overall criteria instead).
Algorithm: stable sort by cascade where each comparator refines equivalence classes;
implement as iterative partition refinement, not pairwise compare (pairwise breaks
transitivity for h2h).

### 4.3 Exact arithmetic
Ratio metrics (NRR, set/point ratio, Buchholz averages) compare by **cross-multiplication
of integer ledgers** (`a.rf·b.of vs b.rf·a.of`) — no floats in ordering. Display rounds to
3 dp; ordering never does.

### 4.4 `lots`
Seeded PRNG (division rngSeed + tie-group ids, sorted) ⇒ deterministic, reproducible,
audited via division event. Presented in UI as "drawing of lots (automated)".

## 5. Division events (structural ledger)

`division_events`: `stage_opened`, `fixtures_generated {inputsHash}`, `fixture_replaced`,
`stage_completed {finalRanks}`, `rank_lock {method}`, `entrant_withdrawn {policy}`.
Withdrawal policies: `void_remaining` (league: expunge or award per config — expunge if
< 50% played, else award remaining as forfeits, mirroring common league rules) and
`bracket_walkover` (KO).

## 6. Invariants (CI property tests)

- Generators: completeness/uniqueness per §2; brackets: every non-bye path from any leaf
  reaches the final in `log2(S)` steps; DE: champion has ≤ 2 losses, all others ≥ 1... etc.
- Cascade: total order (antisymmetric, transitive on sampled triples), stable under
  irrelevant-fixture perturbation (changing a fixture between non-tied entrants outside
  the tie-group never reorders the tie-group's internal ranking for h2h keys).
- Progression: qualification output size matches next stage input; idempotent regeneration.

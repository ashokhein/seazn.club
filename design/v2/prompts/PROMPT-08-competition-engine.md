# PROMPT-08 — Competition Engine: Stages, Standings, Tiebreaker Cascade

**Read first:** `engine/05-formats-progression-tiebreakers.md` (whole doc, normative);
`engine/02-domain-model.md` §5, §7. Preamble: PROMPT-00. Depends: PROMPT-03 (uses generic
+ any landed sport modules in tests).

## Task
Implement `competition/` (pure — fixture generation itself is PROMPT-09; use injected
generator stubs here):

1. `stage.ts` — stage state machines for all six kinds (05 §1): completion predicates,
   `division_events` emission (`stage_opened`, `stage_completed {finalRanks}`,
   `rank_lock_required/rank_lock`), entrant-withdrawal policies (05 §5:
   `void_remaining` with <50%-played expunge-vs-award rule, `bracket_walkover`).
2. `standings.ts` — fold `StandingsDelta`s over decided fixtures into `StandingsRow[]`
   with the sport's `MetricSpec` ledger; deterministic given fixture set (order-independent
   fold — assert with a property test).
3. `tiebreakers.ts` — comparator registry for every `TiebreakerKey` in 05 §4.1, including:
   - **h2h partition-refinement** exactly per 05 §4.2 with `h2hRecursive` flag (UEFA
     recursive vs FIFA fall-through) — this is the hardest part; unit-test with the
     three-way-tie examples where pairwise comparison gives the wrong (intransitive) answer.
   - Swiss cascade-time metrics: buchholz, buchholz_cut1, sberger computed from the
     boardgame ledger (see PROMPT-07 note), direct encounter, wins.
   - Cross-multiplication rational comparators (nrr, set_ratio, point_ratio) — no floats.
   - `seed`, `lots` (seeded rng from division rngSeed + sorted tie-group ids; emits
     rank_lock_required per 05 §3).
   - Cascade validation: reject keys whose metrics the sport doesn't maintain.
4. `qualification.ts` — resolve specs (05 §3): pool-rank picks, topN, best-of-rank across
   pools (incl. unequal-pool normalisation flag), producing an ordered seed list;
   idempotence property.
5. Property suite (05 §6): cascade total order on sampled triples; irrelevant-fixture
   stability; standings fold order-independence; qualification size correctness.
6. Golden: FIFA 2026-style 4-team group where H2H-first and GD-first presets produce
   *different* orders — assert both.

## Acceptance
- All properties + goldens green. Public API of `competition/` documented with spec refs.
- A full simulated division (generic sport, group→knockout) runs end-to-end in a test
  using stub generators.

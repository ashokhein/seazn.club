# PROMPT-06 — Set-Based Sports Kernel (Volleyball, Badminton, Table Tennis)

**Read first:** `engine/04-sport-scoring-specs.md` §3–5, §9; verify BWF/ITTF details per
`engine/11-sources.md` "still to fetch". Preamble: PROMPT-00. Depends: PROMPT-03.

## Task
1. `sports/setbased/kernel.ts` — one parametric engine:
   `{bestOf, setTo, finalSetTo, winBy, cap, pointsMap}`; events `rally {wonBy}` +
   `set.summary {home, away}` (dual fidelity); set-win predicate
   (≥ setTo, margin ≥ winBy, hard `cap` golden point); match decision at ⌈bestOf/2⌉;
   deciding set uses `finalSetTo`. `supportsDraws` always false.
   Validation: `set.summary` scores must be *reachable* under the predicate
   (reject 25-24 when winBy 2 and no cap; accept 30-29 when cap 30).
2. Three preset modules wrapping the kernel:
   - `volleyball`: indoor `{5,25,15,2,null}` + beach `{3,21,15,2,null}`; FIVB pointsMap
     (3-0/3-1→3:0, 3-2→2:1); metrics `sets_won/sets_lost/points_won/points_lost`;
     cascade `points → wins → set_ratio → point_ratio → h2h`; positions S/OH/MB/OPP/L
     with libero role; lineup 6 + libero rules (validation only).
   - `badminton`: `{3,21,21,2,30}`; disciplines via entrant kind (no module change);
     no positions; cascade `points → wins → game_ratio → point_ratio → h2h`.
   - `tabletennis`: `{5|7,11,11,2,null}`; note in code: team ties = future
     `parent_fixture_id` feature, NOT this module.
3. Ratio metrics stored as integer pairs; comparator = cross-multiplication with
   zero-denominator ⇒ +∞ first (spec 04 §3.4).
4. Goldens: volleyball 3-2 (25-20, 23-25, 25-18, 24-26, 15-13) → 2:1 points split;
   badminton golden point 30-29; TT 4-3 in best-of-7; a 32-30 extended volleyball set.
5. Property: every generated rally stream terminates the set; set score at decision
   always satisfies the predicate; kernel with cap=null never ends below winBy margin.

## Acceptance
- Conformance green ×3 presets; dual-fidelity hook green; shared kernel = zero duplicated
  set logic across the three modules.

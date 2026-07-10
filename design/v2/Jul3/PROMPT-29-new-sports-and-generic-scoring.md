# PROMPT-29 — Generic Configurable Sport Module & New-Sport Presets

**Read first:** `engine/Jul3/09-new-sports-and-generic-scoring.md` (normative);
`engine/03-engine-architecture.md` (SportModule contract) + PROMPT-03 conformance kit;
`engine/04-sport-scoring-specs.md` §9 (generic/invariants); `engine/14-score-granularity.md`.
Preamble: PROMPT-00. **Depends:** PROMPT-03 (contract). Reuses Jul3/05 `PointsRule`.

## Task
1. **Generic module** `sports/generic/` (Jul3/09 §2) — **pure**, PROMPT-03-conformant:
   `GenericCfg` Zod (metrics with `kind: int|decimal|signed`, `higherWins`, `decidedBy`,
   `labels`, `points`); events `generic.result {metrics}`, `generic.adjust`; fold →
   `StandingsDelta` from declared metrics; feeds cascade (doc 05 §4) + custom points
   (Jul3/05). `arbitraryEvent` generator + full conformance suite.
2. **Presets** (Jul3/09 §3): `sport_variants` rows over `generic` for baseball (Runs),
   darts (legs + legDiff + average), netball, Tchoukball, race (ascending), Ludosport
   (decimal hits+style, fractional points), Mölkky. Each documented with its metrics/labels/
   points.
3. **Metric-label overrides** (Jul3/09 §6): division-config label map flowing to standings/
   exports/dashboard; canonical metric `key` unchanged (rename display only).
4. **Multi-event combined ranking** (Jul3/09 §4): pure `combineRankings(divisionStandings[],
   config) → CombinedRow[]`; competition-level `combined_ranking` config
   (`rank_points|sum_points`); derived read model, no new truth. Satisfies 16-Mar
   independent-group-stages-per-sport via multiple `qualification:'all'` divisions + combiner.
5. **Data-driven scorer pad** (Jul3/09 §7): scorer console renders a numeric pad from
   `metrics` (no bespoke UI per generic sport); decimal/signed inputs supported.
6. **Entitlements/registry** (Jul3/09 §6): generic sports seed via registry-sync; generic
   sports free like built-ins; `generic.custom_metrics` + `combined_ranking` = Pro.

## Acceptance
- `conformanceSuite(generic)` green; goldens: Ludosport fixture with fractional hits+style
  decides correctly and sums fractional points; darts leg-diff tiebreak; a race division
  ranks ascending; a relabelled table shows `Runs`/`Score` while keeping canonical keys.
- Golden: two-division "football + basketball" competition combined via `rank_points` →
  overall table; no forced progression between the two sports.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes. Golf (per-hole/
  handicap) and Kinball (3-entrant fixture) are **out of scope here** — flagged as their own
  follow-up design+prompt in Jul3/09 §3, §5.

# Jul3/09 — New Sport Modules & Generic Configurable Scoring

Adds the long tail of requested sports via one **generic points-based module** plus a few
thin presets, and fixes score-label/format gaps. Rides the `SportModule` contract
([03-engine-architecture.md](../03-engine-architecture.md), PROMPT-03) — no engine-core
change. Design only.

## 1. Motivation & scope

- **Whole new sports** — Tchoukball (29 May), golf (7 Aug), running/race (30 Apr), Raketlon
  (27 Feb), Ludosport (1 Oct), darts (28 Nov), baseball (29 July), Kinball 3-team (2 Feb),
  Mölkky/skittles, netball (26 Jan), hockey.
- **Generic scoring needs** — floating-point + negative scores (1 Oct Ludosport; 15 Mar ×1
  half/minus scores); rename `PLD/W/D/L/PTS/PF/PA/PD` (11 Oct ×3 sumo-robot; 29 July baseball
  "Runs" not "Goals"); rename scoring methods (8 Apr); multi-event rank collation (17 Mar;
  16 Mar multi-sport school league); corner count as a decider (4 Apr); darts leg-diff /
  average columns (28 Nov).
- **Score granularity toggles** — enter set match as "3–1" only (23 Apr); tennis real scores
  "6–4 6–4" + tiebreak (2 Jun, 25 Jun); overall-set-score vs per-game (owned by doc 14, ref'd).

**In scope:** a `generic` configurable module (metrics, labels, points, decimals/negatives),
presets for the simple sports, a multi-event ranking aggregator, and a metric-label override
layer. **Out:** deep bespoke rules engines for golf handicaps / cricket DLS (cricket already
has its module, doc 04/05) — golf/race land as generic-score presets first, deepen later.

## 2. The `generic` module (covers most of the tail)

Most requested "sports" are really *configurable scoring shells*: N entrants, one or more
numeric metrics, a points rule, a ranking. One module, config-driven (same contract as
football/cricket, PROMPT-03):

```ts
GenericCfg = z.object({
  metrics: z.array(z.object({                 // e.g. hits, style, runs, legs, points
    key: z.string(), label: z.string(),
    kind: z.enum(['int','decimal','signed']), // decimal → Ludosport floats; signed → minus scores
    higherWins: z.boolean().default(true),
  })),
  decidedBy: z.string(),                       // which metric decides the fixture
  labels: z.record(z.string(), z.string()).optional(),  // rename PLD/W/D/L/PTS/PF/PA (11 Oct)
  points: z.lazy(() => PointsRule),            // reuse Jul3/05 §2
});
```

- **Ludosport** (1 Oct): `metrics:[{key:'hits',kind:'decimal'},{key:'style',kind:'decimal'}]`,
  fractional points — the `decimal` kind is exactly the "floating point values" ask.
- **Sumo-robot / non-sports** (11 Oct): `labels:{PTS:'Score',PF:'Wins'}` renames columns.
- **Baseball** (29 July): a generic preset with `metrics:[{key:'runs',label:'Runs'}]` —
  "Runs" not "Goals" is a label, not a code change. (A deeper innings module can come later.)
- **Darts** (28 Nov): `metrics:[{key:'legs'},{key:'legDiff'}]`, leg-difference as a
  tiebreaker metric + average column.
- **Race/running** (30 Apr): finishing position/time as the metric; rank ascending
  (`higherWins:false`) — ties into §4 multi-event.

The generic module emits `generic.result {metrics}` and `generic.adjust` events, folds to a
`StandingsDelta` from the declared metrics, and feeds the tiebreaker cascade (doc 05 §4) and
custom points (Jul3/05). Conformance suite (PROMPT-03 kit) applies unchanged.

## 3. Thin presets vs full modules

- **Generic presets** (ship first, cheap): baseball, darts, netball, Tchoukball, race,
  Ludosport, Mölkky — each a `sport_variants` row over `generic` with metrics/labels/points.
- **Full modules** (only where match grammar is genuinely different): golf (stroke/stableford
  scoring over holes, handicaps) and Kinball (3-entrant fixtures) need real modules — golf
  has a per-hole ledger, Kinball breaks the two-sided fixture assumption. Flag both as their
  own follow-up prompts; deliver the generic presets now.

## 4. Multi-event / multi-sport combined ranking (17 Mar, 16 Mar)

"Score participants by rank across events and collate an overall winner" (17 Mar) and "same
teams compete in football + basketball + handball, combine" (16 Mar):

- Model as a **competition-level aggregate** over sibling divisions (each event = a
  division). A `combined_ranking` config on the competition: `{ divisions:[...], scoring:
  'rank_points'|'sum_points', rankPoints:[10,8,6,...] }`.
- Pure `combineRankings(divisionStandings[], config) → CombinedRow[]` — reads each division's
  final standings (already computed) and folds to an overall table. No new truth; a derived
  read model, sibling to `stats.club_championship` (doc 10, doc 06 §4.4).
- The 16-Mar "independent group stages per sport, manual assignment, no dependency on prior
  results" is satisfied by multiple divisions each with `qualification:'all'` + this
  combiner — no forced progression between sports.

## 5. Kinball / 3-team fixtures (2 Feb)

Genuinely breaks the 2-sided fixture aggregate (doc 02 §6). Scoped note only: needs
`fixture` to allow N entrants (an `entrant_slots` array) and the sport module to score a
multi-party contest. Non-trivial — flag as its own design + prompt; do **not** fold into the
generic module (which assumes 2 sides). Documented so the ask isn't lost.

## 6. API & entitlements

- New sports/variants seed via the registry-sync into `sports` / `sport_variants` (doc 07);
  divisions bind them like any sport (doc 02 §4).
- Metric-label overrides are division config → flow to standings/exports/dashboard labels.
- Entitlements: generic sports available same as built-in sports; `generic.custom_metrics`
  (>N metrics, custom labels) and `combined_ranking` = Pro (aligns with
  `stats.club_championship` Pro, doc 10).

## 7. Edge cases

- Signed/decimal metrics must sum correctly in standings + points (Jul3/05 §2 numbers).
- Rename labels must not break existing tiebreaker keys — labels are display-only; the
  metric `key` stays canonical (rename `PF`'s label, not its identity).
- Ascending-rank sports (race, golf) invert winner logic — `higherWins:false` handled in the
  fold and the cascade comparator.
- A generic preset requesting a metric the UI has no input for → the scorer console renders
  a generic numeric pad from `metrics` (data-driven, no bespoke UI per sport).

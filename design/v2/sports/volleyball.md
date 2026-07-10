# Volleyball — Engine & Scoring Architecture

Module: `volleyball` (preset over `setbased` kernel) · Spec anchor:
`04-sport-scoring-specs.md` §3 · Implementation: PROMPT-06 · Source: FIVB Official Rules
2025–2028 ([11-sources.md](../11-sources.md)).

## 1. What makes volleyball different
Rally scoring with an **uncapped win-by-two endgame** (sets can run 32-30), a shorter
deciding set, and a standings convention where **match points depend on the set score**
(3-0/3-1 → 3 pts; 3-2 → 2/1 split) with *ratio* tiebreakers — plus roster rules (libero)
that constrain lineups but never scoring.

## 2. Match model (kernel parameters)
```
Cfg indoor: { bestOf: 5, setTo: 25, finalSetTo: 15, winBy: 2, cap: null,
              pointsMap: {'3-0': [3,0], '3-1': [3,0], '3-2': [2,1]} }
Cfg beach:  { bestOf: 3, setTo: 21, finalSetTo: 15, winBy: 2, cap: null }
```
State: `{ sets: [{home, away, closed}], current: {home, away}, matchOver }`.

### Set-win predicate (kernel)
`score ≥ setTo(currentSet) && score − other ≥ winBy` — 24-24 plays on (26-24, 27-25, …);
`cap: null` means no golden point (unlike badminton). Deciding set (set index =
bestOf) targets `finalSetTo`. Match = first to ⌈bestOf/2⌉ sets. `supportsDraws` false
everywhere.

## 3. Events — dual fidelity
- Fine (Pro `scoring.rally_by_rally`): `rally {wonBy}`; optional no-score events
  `timeout {by}`, `sub {by, off, on}`, `libero {by, in, out}` — validated (2 timeouts/
  set, libero replacement rules as *warnings* not blocks — courtside reality).
- Coarse (Community): `set.summary {home, away}` — validated reachable under the predicate
  (reject 25-24; accept 27-25; deciding-set numbers vs finalSetTo).
- `coarsen(rallyEvents) ≡ summaries` conformance hook mandatory.

## 4. Standings & tiebreakers (FIVB convention)
Ledger (integers): `matches_won, matches_lost, sets_won, sets_lost, points_won,
points_lost` + competition points from `pointsMap`.
Cascade: `points → matches_won → set_ratio → point_ratio → h2h`.
Ratios = cross-multiplied integer pairs; `sets_lost = 0` ⇒ +∞ ranks first (undefeated
3-0 team). Alternative points schemes (2/1/0 win-loss, or 2 pts flat) via cfg for school
leagues.

## 5. Positions, lineup, roster
Catalog: S (setter) / OH / MB / OPP / L (libero). Lineup: 6 starting + libero(s) + bench;
role libero unique-per-set constraints tracked as metadata; rotation order (I–VI court
positions) is **Pro-stat metadata**, not enforced — referees enforce rotation, not us.
Profile attrs: `{height?, spike_reach?, block_reach?, position}` display-only.

## 6. Format notes
- Pool play → knockout is the dominant format; set_ratio makes pool ranking sensitive to
  dead-rubber sets — surface "what's needed" scenarios (Pro dashboard widget, later).
- Golden-set rule (some cups decide a two-leg tie with one set to 15): model as a child
  fixture with `{bestOf: 1, setTo: 15}` — kernel handles it free.
- Beach: pairs (entrant kind `pair`), sides switch every 7/5 points — display metadata only.

## 7. Edge cases checklist
- Forfeit at 0-0 → award 3-0 (25-0 ×3) per FIVB; mid-match forfeit → completed sets
  stand, remaining awarded 25-0 — cfg `awardSetScore`.
- Injury with no substitutes ⇒ team incomplete ⇒ forfeit current set + match per rules.
- 5th-set side-switch at 8 — display marker.
- `set.summary` for an unfinished deciding set (abandoned) ⇒ `no_result` (rare; gyms
  close) with cfg points split.

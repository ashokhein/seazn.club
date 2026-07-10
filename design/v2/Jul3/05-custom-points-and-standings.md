# Jul3/05 — Custom Points Systems, Standings Carry-Over & Manual Rank Control

Extends the standings fold + tiebreaker cascade
([05-formats-progression-tiebreakers.md](../05-formats-progression-tiebreakers.md) §3–4,
PROMPT-08) with configurable competition-points, phase carry-over, manual rank override, and
richer forfeit/decision handling. Design only.

## 1. Motivation & scope

- **Custom points systems** — netball "Win 5 / Draw 3 / losing-but-≥50% 1 / else 0" (26
  Jan); rugby-style "bonus point for not losing by >X" (7 Jan); "2 pts win-by-one, 1 pt
  lose-by-one" (22 Oct); forfeit points config (20 Jan).
- **Standings carry-over** (14 Apr handball; 25 Nov ×; 16 Sep) — Phase-1 results carry into
  Phase-2 groups instead of teams replaying from zero.
- **Manual rank override** (24 Oct; 3 Jun) — final-placement games decide 3rd/4th; organiser
  sets positions not from raw points.
- **Tie alert** (10 Jun ×1) — warn when teams tie on *all* criteria before KO (today it
  silently breaks ties alphabetically).
- **Forfeit / walkover / no-show** (20 Jan; 2 Jun) — mark forfeit with configurable points
  for each side; double-forfeit/unplayed without fake scores (8 Dec ×1).
- **Penalty-shootout result** (28 Jun ×1; 7 Jul; 12 Jun) — record the decider + show it.
- **UEFA circular H2H override** (3 Sep) — choose overall GD vs mini-table GD in a 3-way tie.
- **Fair-play score** (3 Sep) — track a fair-play metric for a fair-play cup.

**In scope:** a `PointsRule` config on the stage, carry-over qualification, a rank-lock/
override mechanism, forfeit/abandon points config, penalty-decider capture, extra tiebreaker
metrics. **Out:** new sport match grammars (Jul3/09); these ride the existing StandingsDelta
plumbing (doc 02 §7).

## 2. Points rule (config, not code)

The sport module contributes a default `PointsRule`; the division may override it. A rule is
declarative and evaluated by the competition engine per decided fixture:

```ts
PointsRule = z.object({
  base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),  // 3/1/0 default
  bonuses: z.array(z.object({                          // ordered, additive
    when: z.enum(['loss_margin_lte','win_margin_gte','score_ratio_gte',
                  'draw','forfeit_win','forfeit_loss','no_result']),
    param: z.number().optional(),                      // X for margin/ratio rules
    points: z.number(),
  })).default([]),
  forfeit: z.object({ winnerPoints: z.number(), loserPoints: z.number(),
                      awardScore: z.tuple([z.number(), z.number()]).optional() }),  // 20 Jan
});
```

Examples encode the exact asks:
- Netball (26 Jan): `base {win:5,draw:3,loss:0}, bonuses:[{when:'score_ratio_gte',param:0.5,
  points:1}]` applied to the losing side.
- Rugby (7 Jan): `bonuses:[{when:'loss_margin_lte',param:7,points:1}, {when:'win_margin_gte',
  ...}]`.
- One-goal (22 Oct): `bonuses:[{when:'win_margin_gte',param:1... }]` variant.

Rule stored on `stages.config.points`. Sport modules already emit margins/ratios in
`StandingsDelta.metrics` (doc 02 §7) — the rule reads those, so **no sport-module changes**.
Fractional points allowed (Ludosport, Jul3/09) — `points` is a number, standings sum keeps a
decimal metric.

## 3. Carry-over qualification (14 Apr, 25 Nov, 16 Sep)

The stage graph already has a `qualification` spec (doc 02 §5). Add a carry mode:

```ts
qualification = { from_stage, take: [...],
                  carry: 'none' | 'points' | 'full' }   // NEW
```

- `carry:'points'` — seeded entrants arrive in the new pool with their prior-stage points
  (and chosen metrics) as an opening StandingsDelta; head-to-head games already played are
  *not* replayed (16 Sep: "3 teams from each group advance, don't play each other again").
- `carry:'full'` — also carries the played-fixture results (for GD/H2H) so the second-phase
  table is a true continuation.

Implemented as a synthetic opening delta folded before new fixtures — the standings fold is
already additive (doc 02 §7), so carry-over is data, not new fold logic. Recorded as a
`division_events: standings_carried` row (auditable).

## 4. Manual rank override & rank-lock (24 Oct, 3 Jun)

`standings_snapshots.rows[].rank_locked` already exists in the model (doc 02 §7). Expose it:

```
POST /api/v1/stages/{id}/standings/override
  { rows: [{ entrant_id, rank, locked: true, reason }] }   -- 3rd/4th from a placement game
```

Locked ranks are pinned; the cascade ranks only the un-locked remainder around them. Emits
`division_events: rank_overridden` (actor + reason, hash-chained). Public view shows the
final order; the override is audit-visible to staff. This is how "winner of 3rd-place game =
3rd" is set without faking points (24 Oct exact ask).

## 5. Tiebreaker additions (extends doc 05 §4)

The cascade is already a configurable, sport-fed ordered list. Add:
- **Tie-exhaustion alert** (10 Jun): when two rows remain equal after the *entire* cascade,
  the fold sets `rows[].tie_unbroken = true` and emits a `warn` — the console shows an alert
  before KO seeding instead of silently going alphabetical. `tiebreakers.custom` (Pro,
  doc 10) lets the organiser add a decider (drawing of lots / manual) as the final step.
- **Circular H2H mode** (3 Sep): a cascade flag `h2h_scope: 'mini_table' | 'overall'` for
  the ≥3-way-tie head-to-head step (UEFA mini-table default; override to overall GD).
- **Fair-play metric** (3 Sep): sport modules that emit cards already contribute
  `fair_play` in `metrics`; expose it as a selectable cascade step and a standalone
  fair-play-cup standings view.

## 6. Forfeit, abandonment, penalty decider

- **Forfeit/walkover**: a `core.forfeit {winnerEntrantId}` event (already terminal, doc 02
  §6) → outcome + points from `PointsRule.forfeit`. Double-forfeit / unplayed:
  `core.no_result` → both sides get `no_result` bonus points (0 default) with **no fake
  score** (8 Dec exact ask — round-robin best-of-7 no longer forces a 4–0).
- **Penalty shootout** (28 Jun, 12 Jun): sport modules with shootouts (football) already
  carry a `shootout` payload in the outcome; surface it in the summary + presentation slide
  and in standings when a format counts shootout wins. Set-based "just enter 3–1" (23 Apr)
  and tennis "6–4 6–4 / tiebreak" (2 Jun, 25 Jun) are the set-module's granularity toggle
  (doc 14) — cross-referenced, owned there.

## 7. Entitlements

- Base points config (win/draw/loss numbers) = all plans. Bonus rules + carry-over +
  circular-H2H mode + manual override = Pro (`tiebreakers.custom` already Pro, doc 10; add
  `standings.custom_points`, `standings.carry_over`).
- Tie-unbroken alert = all plans (safety/clarity).

## 8. Edge cases

- Points rule change mid-stage → recompute is a pure refold of decided fixtures (standings
  are disposable, doc 02 §7); emit an audit event; never silently reorder a locked rank.
- Carry-over + manual override interacting: override wins (it's the final structural word).
- Bonus rules referencing metrics a sport doesn't emit → validation error at stage config
  (fail closed, PROMPT-00 §3 "bad configs can never reach play").
- Negative/fractional points sum correctly (Jul3/09 generic sports).

# Cricket — domain audit (W4, #407 programme)

## What this is

A per-fact audit of the cricket module against what a real cricket scorebook
records, one row per scorable fact, per declared variant. The question this
answers is **not** "does the UI show it" but "can the schema even hold it":

```
sport reality  ⊇  eventSchema / configSchema / State / summary
```

A fact marked `deferred` here is a fact no scorer will be able to record until
someone lifts it, so every deferral carries its reason.

**Audited against**

- MCC *Laws of Cricket* (2017 Code, 3rd edition 2022) — Laws 4 (the ball),
  15 (declaration and forfeiture), 18 (scoring runs / short runs), 20 (dead
  ball), 21 (no ball), 22 (wide), 23 (bye and leg bye), 24 (fielder's absence
  and substitutes), 25 (batter's innings and runners), 20.4/41 (penalty runs),
  and the ten modes of dismissal in Laws 30–39.
- ICC *Standard Playing Conditions* for Test, ODI and T20I — free hit, DRS,
  powerplays, the two-new-balls ODI condition, super over.
- The ECB/ACS linear and card scorebook conventions: batting card, bowling
  figures, extras columns (b / lb / w / nb / pen), fall of wickets,
  partnerships.
- ICC/ECB *Duckworth-Lewis-Stern Standard Edition* for the revision math
  already implemented in `dls.ts`.

**Declared variants** (`cricket.variants`): `t20`, `odi`, `hundred`, `test`,
`pairs-6-a-side`. They differ materially and the table says where.

| variant | innings/side | balls/innings | balls/over | players | notes |
|---|---|---|---|---|---|
| `t20` | 1 | 120 | 6 | 11 | 4-over bowler quota, free hit, powerplay, super over available |
| `odi` | 1 | 300 | 6 | 11 | 10-over quota, `minOversForResult` 20, two new balls in practice |
| `hundred` | 1 | 100 | **5** | 11 | balls counted in fives; "overs" in this module means `ballsPerOver` sets, so 100 balls = 20 sets |
| `test` | **2** | **null** (unlimited) | 6 | 11 | declarations, follow-on (lead 200), draw points, no free hit (red ball), no super over |
| `pairs-6-a-side` | 1 | 60 | 6 | **6** | all-out at 5 wickets; the pairs convention itself is **deferred** (see below) |

Two module-wide facts that shape every row:

1. **Dual fidelity is the load-bearing design.** `cricket.ball` (Tier 3) and
   `cricket.innings.summary` (Tier 0) both fold into the same
   `{runs, wickets, legalBalls}` totals, and all result / NRR / DLS math reads
   only those totals. `coarsen()` collapses a fine stream into a coarse one and
   conformance §9.6 asserts the two folds agree on **outcome and summary**.
   That is why fine-only facts (fielding credit, retirements as such,
   powerplays, reviews) must NOT appear in `summary` — a coarse fold cannot
   reproduce them.
2. **The golden corpus compares `JSON.stringify` of the whole state**, per
   event. Every field added by this wave therefore stays `undefined` until the
   fact it records actually occurs; an innings that uses none of them
   serialises exactly as it did before the wave. `cricket.golden.json` is
   byte-unchanged and `module.version` stays `1.0.0`.

---

## Mapping table

`Ev.X` = event payload schema, `Cfg.x` = config, `State.x` = folded state,
`summary.x` = `module.summary()` output. Person fields are always optional —
coarse scoring must stay legal.

### The delivery

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| A delivery happened, in a numbered over | all | entrant (batting side, implicit) | `Ev.CricketBall.over` / `.ballInOver` | modelled | fold rejects a cursor that disagrees with the ledger; `hundred` counts in fives via `Cfg.ballsPerOver` |
| Runs off the bat | all | person: `striker` | `Ev.CricketBall.runs.bat` → `State.innings[].fine.batterRuns` | modelled | |
| Ball faced | all | person: `striker` | `Ev.CricketBall.striker` → `.fine.batterBalls` | modelled | not incremented on a wide (Law 22.6) |
| Non-striker at the other end | all | person: `nonStriker` | `Ev.CricketBall.nonStriker` → `.fine.nonStriker` | modelled | fold pins it against the ledger; strike rotation on odd runs is folded |
| Bowler of the delivery | all | person: `bowler` | `Ev.CricketBall.bowler` → `.fine.bowlerBalls` / `.bowlerRuns` | modelled | one bowler per over, no consecutive overs, `Cfg.maxOversPerBowler` all enforced |
| Boundary 4 or 6 (vs runs run) | all | person: `striker` | `Ev.CricketBall.boundary` → `State.innings[].boundaries` | modelled | suppresses the strike crossing; feeds `superOverStillTied: "boundary_count"` |
| Wide | all | — (charged to bowler) | `Ev.CricketBall.runs.extras.kind = "wide"` | modelled | illegal delivery, no ball faced, bat runs rejected |
| No ball | all | — (charged to bowler) | `…extras.kind = "noball"` | modelled | Law 21.13 puts *all* non-bat runs off a no ball in the no-ball column, so the single-kind extras shape is the correct scorebook entry |
| Bye / leg bye | all | — | `…extras.kind = "bye" / "legbye"` | modelled | legal delivery, not charged to the bowler |
| Penalty runs to the **batting** side | all | — | `…extras.kind = "penalty"` | modelled | lands in the batting innings total and in `.fine.extras` |
| Penalty runs to the **fielding** side | all | — | — | deferred | Law 41 adds them to the fielding side's own score, i.e. to a *different* innings that may not exist yet; it would change `aggregate()`, the innings-victory test and the NRR ledger. Needs a product decision on how a penalty bank scores for NRR before it can be modelled. |
| Free hit armed and consumed | white-ball variants (`t20`, `odi`, `hundred`, `pairs-6-a-side`) | — | `Ev.CricketBall.freeHit` → `.fine.freeHitPending` | modelled | armed by a no ball, survives an intervening wide, consumed by the next legal ball; only run-out/obstruction may dismiss on it. Deliberately off for `test` (red-ball) |
| Short run | all | person: `striker` | — | deferred | Law 18.5 deducts the run before it is entered, so the ledger's `runs.bat` is already the post-deduction figure. The umpire's signal is annotation, not a total — `core.note` carries it. |
| Dead ball | all | — | — | deferred | A dead ball that does not count is simply not entered in the ledger; one that does count is entered as the delivery it was. Nothing to hold. |

### Dismissals

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Bowled / LBW / hit wicket | all | persons: `out`, `bowler` | `Ev.CricketBall.wicket.kind` | modelled | `bowlerCredited` must be `true`; fold rejects the wrong value |
| Caught | all | persons: `out`, `fielder`, `bowler` | `…wicket.fielder` → `.fine.fielding[p].catches` | **extended** | `fielder` existed but was parsed and dropped; it is now validated against the fielding lineup and folded into a per-person fielding card |
| Stumped | all | persons: `out`, `fielder` (the keeper), `bowler` | `…wicket.fielder` → `.fine.fielding[p].stumpings` | **extended** | same fold; `bowlerCredited` stays `true` |
| Run out | all | persons: `out`, `fielder`, `fielderAssist` | `…wicket.fielder`, `…wicket.fielderAssist` → `.fine.fielding[p].runOuts` | **extended** | `fielderAssist` is new: the scorebook's "run out (thrower/breaker)". `fielder` = the fielder who completed it (broke the wicket), `fielderAssist` = the supporting fielder; both are credited a run out. Requires `fielder` and must differ from it. |
| Obstructing the field | all | persons: `out`, `fielder` | `…wicket.kind = "obstructed"` | modelled | credits the fielder a run out; "handled the ball" was folded into this by the 2017 Code |
| Timed out | all | person: `out` | `…wicket.kind = "timedout"` | modelled | |
| Retired out (as a delivery-time entry) | all | person: `out` | `…wicket.kind = "retired"` | modelled | legacy path, kept for back-compat; `cricket.retire` below is the richer one |
| **Hit the ball twice** | all | person: `out` | `…wicket.kind = "hitballtwice"` | **extended** | Law 34 — the tenth mode of dismissal, previously absent from the enum. Credited to no bowler, so `bowlerCredited` must be `false`. |
| Wicket-keeper distinguished from a fielder | all | person: `fielder` | `positions.roles[].key = "wicketkeeper"` | deferred | the keeper is a lineup role (required, unique), so "†" on a scorecard is derivable from the lineup rather than repeated on every ball. Recording it per delivery would be denormalised and could contradict the lineup. |
| Who threw vs who broke the wicket | all | persons: `fielder`, `fielderAssist` | `…wicket.fielderAssist` | **extended** | judged scoreable: it is the standard scorebook entry for a run out. The pair is ordered (completer, assister) rather than (thrower, breaker) because the completer is the one the card always names. |
| Bowler wicket credit | all | person: `bowler` | `…wicket.bowlerCredited` → `.fine.bowlerWickets` | modelled | fold pins credit to the mode of dismissal — it is not a free-text flag |
| Fall of wickets / partnership at each wicket | all | persons: both batters | — | deferred | fully derivable by replaying the ledger (the totals at each `wicket`-bearing event *are* the fall of wickets), and folding it would materialise an array on every existing innings, which the frozen golden corpus compares byte-for-byte. Belongs in a read-side projection, not the fold. |

### Batters coming and going

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Openers | all | persons | `State.innings[].fine.striker` / `.nonStriker` from lineup `orderNo` | modelled | |
| Who comes in next | all | person: `incoming` | `Ev.CricketBall.wicket.incoming` | **extended** | Law 25.1 leaves the order after the openers entirely to the captain; lineup `orderNo` is now only the default. Validated against the lineup, refused if the batter is out or already in. |
| Retired **hurt / ill** (not out) | all | persons: `person`, `incoming` | `Ev.CricketRetire` (`cricket.retire`), `reason: "hurt"/"other"` → `.fine.retiredNotOut` | **extended** | costs the side no wicket; the batter stays available. Unrepresentable before: the only retirement path was `wicket.kind = "retired"`, which always takes a wicket. |
| Retired **out** | all | person: `person` | `cricket.retire`, `reason: "out"` | **extended** | Law 25.4.3 — a dismissal credited to no bowler; increments `State.innings[].wickets` and can close the innings |
| A retired batter **resumes** | all | person: `incoming` | `Ev.CricketBall.wicket.incoming` / `Ev.CricketRetire.incoming` | **extended** | naming a retired-not-out batter as `incoming` takes him off `retiredNotOut`. When no batter who has not yet batted remains, a retired-not-out batter resumes automatically — this keeps the number of available batters equal to the all-out threshold whatever the retirements were, which is what lets a *coarse* fold (which never sees the retirements) close the innings at exactly the same wicket. |
| Substitute fielder | all | person | — | deferred | a substitute may field but not bat, bowl or keep (Law 24), so nothing on a scorecard changes. No fold-visible fact. |
| Concussion / COVID replacement | `t20`, `odi`, `test` (ICC conditions) | person | — | deferred | a like-for-like replacement *can* bat and bowl, so it changes the lineup mid-match. Lineups reach the module through `init(cfg, lineups)`, not through the event stream; making a squad mutable mid-fixture is an architecture decision above this module. |
| Runner for an injured batter | none in practice | person | — | deferred | withdrawn from the Laws for adult cricket in 2011; the module's tiers do not target the formats that still allow it. |

### The innings

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Innings totals (runs / wickets / legal balls) | all | entrant | `State.innings[].{runs,wickets,legalBalls}`, `Ev.CricketInningsSummary` | modelled | the one shape every downstream computation reads |
| Extras total | all | entrant | `State.innings[].fine.extras` | modelled | per-kind breakdown lives on each ball, not aggregated on the innings |
| Innings closed, and **why** | all | entrant | `Ev.CricketClose.reason` → `State.innings[].closeReason`, `summary.detail.innings[].closeReason` | **extended** | new optional enum (`all_out`, `overs_complete`, `target_reached`, `time`, `weather`, `forfeited`, `other`) on the explicit close event. The three auto-closes are deliberately left unstamped: they are exactly the `autoClose` predicates, so they are derivable from the totals, and stamping them would change every previously folded state. |
| Declaration | `test` (`inningsPerSide === 2`) | entrant | `cricket.innings.declare` → `State.innings[].declared` | modelled | fold refuses it for one-innings variants; shown as `d` in the summary line |
| Innings forfeited | `test` | entrant | `Ev.CricketClose.reason = "forfeited"` | **extended** | Law 15 — recorded as a close reason rather than a distinct event, because the totals a forfeited innings contributes are just zeros |
| Follow-on | `test` | entrant | `cricket.followon` + `Cfg.followOn.{enabled,lead}` → `State.followOnEnforced` | modelled | fold checks the actual lead against the configured one and reorders the innings sequence F,S,S,F |
| All-out threshold | all | entrant | derived: `min(Cfg.playersPerSide, lineup) − 1` | modelled | `pairs-6-a-side` gets 5 from `playersPerSide: 6` |
| **New ball taken** | all (in practice `test`, `odi`) | — | `cricket.newball` → `State.innings[].newBallAt[]` | **extended** | records the legal-ball count at which each new ball was taken; refuses two at the same point. Empty innings keep the field unset. |
| **Powerplay block** | white-ball variants | — | `cricket.powerplay` (`kind`: mandatory/batting/bowling, `phase`: start/end) → `State.innings[].powerplays[]` | **extended** | blocks are `{kind, fromBalls, toBalls}` in legal balls from the innings start; one open block at a time, an end must match the open block's kind |
| Over-rate / time penalty | white-ball variants | entrant | — | deferred | in the current conditions this is either an in-over fielding restriction (a competition rule about the *next* delivery, not a scorable fact) or a points/penalty-run sanction. The penalty-run half needs the fielding-side penalty bank above; the fielding-restriction half needs a product decision on whether a scorer records it at all. |
| Innings-by-innings scoreline | all | entrant | `summary.perSide[].line` (`"250 & 201/5"`), `summary.detail.innings[]` | modelled | reads only totals, so coarse and fine folds render identically (§9.6) |

### Reviews and officiating

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| **A review was taken, by whom** | all (where the competition uses DRS) | entrant `by`, persons `person` (who called it), `against` (the batter concerned) | `cricket.review` | **extended** | |
| **Review outcome** | as above | — | `Ev.CricketReview.outcome` = `upheld` / `struck_down` / `umpires_call` | **extended** | |
| **Reviews remaining** | as above | entrant | `Cfg.reviews.perInnings` + `State.innings[].reviews[side].{taken,lost}` | **extended** | only an unsuccessful *player* review is spent — umpire's call retains it (current ICC conditions) and an umpire review never counts against a side. With `Cfg.reviews` absent the allowance is unlimited, so the config stays byte-identical for every existing division. |
| Umpire identity per decision | all | person | — | deferred | umpires are fixture officials (`officialLabel.scorer = "Umpire"`, officials module), not per-event participants. Naming them on a review would duplicate the officials assignment. |

### Result, points and revision

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Toss and election | all | entrant | `cricket.toss` → `State.battingFirst` | modelled | must precede `core.start` |
| Target for the chase | one-innings variants | entrant | derived `chaseTarget()`, `State.revisedTarget` | modelled | |
| Win by wickets / by runs / by an innings | all | entrant | `State.outcome` + `State.margin` | modelled | innings victory only for `inningsPerSide === 2` |
| Tie / draw / no result / abandoned | all | entrant | `State.outcome.kind`, `Cfg.points.*` | modelled | draw exists only in two-innings cricket and only in league/group/swiss stages |
| Match closed on time (draw) | `test` | — | `cricket.match.close` | modelled | |
| Interruption (rain / light / other) | all | — | `cricket.interruption` → `State.interruptions` | modelled | metadata only; the numbers arrive on `cricket.revise` |
| DLS revision inputs (overs, wickets, resources) | one-innings variants with `Cfg.dls.enabled` | entrant | `cricket.revise.oversPerSide`, `State.r1`/`r2`, `dls.ts` `resources()` | modelled | Standard Edition table; resources lost are computed at the current wickets |
| DLS / manual revised target | as above | entrant | `cricket.revise.target`, `State.revisedTarget`, `State.targetSource` | modelled | a manual umpire target always wins over the computed one |
| DLS par decision on abandonment | as above | entrant | `core.abandon` → `dlsPar()`, method `"dls"` | modelled | below `Cfg.minOversForResult` it is a no result |
| Super over | one-innings variants with `Cfg.superOver` | persons: all ball fields | `cricket.superover.ball`, `State.superOver` | modelled | 2-wicket all out, batting order flips each pair, `Cfg.superOverStillTied` = repeat / boundary_count / shared |
| Net run rate ledger | all | entrant | `standingsDelta().metrics` (`runs_for`, `balls_faced_eff`, …) | modelled | integer ledger only; a bowled-out side is charged its full quota; forfeits contribute nothing |
| Per-result points | all | entrant | `Cfg.points.{win,tie,noResult,loss,draw}` | modelled | `draw` is two-innings only |
| Post-match scorecard lines | all | person | `cricket.player.line` (Tier 2) | modelled | sum-checked against the innings totals; exact against a fine innings, bounded against a coarse one |
| Pairs scoring (6-a-side: fixed pairs, −5 per dismissal) | `pairs-6-a-side` | persons: the pair | — | deferred | the `pairs-6-a-side` variant currently only shrinks the side to 6 and the innings to 60 balls; the actual pairs convention (each pair bats a fixed number of overs, a dismissal costs 5 runs instead of ending the partnership) is a different scoring grammar, not an extension of this one. Needs a product decision on whether we support it before schema is spent on it. |
| Player leaderboards from the ledger | all | persons: all | `module.playerStats` | deferred | **blocked outside this family's blast radius.** `PlayerStatMetric.field`/`sumField` resolve only *top-level* payload keys, and every cricket credit worth a leaderboard is nested — `runs.bat` for the striker, `wicket.fielder` for the catcher, `wicket.bowlerCredited` for the bowler. A half-model (balls faced and wickets, but no runs) would render a misleading table, so nothing was declared. See "downstream owed". |

---

## Downstream owed

Recorded, not acted on.

1. **`src/stats/stats.ts` needs dotted-path support** in `PlayerStatMetric.field`
   and `sumField` (e.g. `"runs.bat"`, `"wicket.fielder"`). It is a shared file
   outside this family's blast radius, so it was not touched. Once it lands,
   cricket can declare a `playerStats` model straight off `cricket.ball`:
   runs (sum `runs.bat` by `striker`), balls faced (count by `striker`), balls
   bowled and runs conceded (by `bowler`), wickets (by `bowler`,
   `when: wicket.bowlerCredited`), catches / stumpings / run outs (by
   `wicket.fielder`, `wicket.fielderAssist`). The fold already keeps all of
   these per innings — only the projection is missing.
2. **`apps/web/src/lib/scoring-vocab.ts` does not know `hitballtwice`.** Its
   `WicketKind` union is closed at nine values; the humanising fallback will
   render it as "Hitballtwice" until a label is added (and translated into all
   four dictionaries). No other engine-side value it knows was removed.
3. **New event types a pad must be able to prompt for**: `cricket.retire`
   (person + hurt/out + optional incoming), `cricket.newball`,
   `cricket.powerplay` (kind + start/end), `cricket.review` (side + player/
   umpire + outcome). All four need vocabulary and i18n on the web side.
4. **New fields on an existing branch**: `wicket.fielderAssist` and
   `wicket.incoming`. A scoring pad that records a run out should offer two
   fielder slots, and a pad that records any dismissal should offer "who's
   in?" rather than assuming lineup order.
5. **New close reasons.** `summary.detail.innings[].closeReason` is now
   sometimes present. Any renderer that enumerates that object must tolerate
   it (it is additive, so a spread-based renderer is already fine).
6. **`Cfg.reviews.perInnings`** is a new optional config key. The rules editor
   and the sports catalog seed (`sync:sports`) do not offer it; the variants
   deliberately do not set it, so nothing changes until a product decision is
   made about which competitions run DRS.
7. **Stat models that become possible**: a fielding leaderboard (catches /
   run outs / stumpings) — new for the product; retirement-aware batting
   averages (a retired-not-out innings is not an out); and per-innings review
   efficiency.
8. **Deferred rows that need a product decision, not engineering**: penalty
   runs to the fielding side (and with it over-rate penalty runs), the
   `pairs-6-a-side` pairs convention, and concussion replacements (which need
   a mutable-squad decision above the module).

## What was NOT changed, on purpose

- `module.version` stays `1.0.0`; `cricket.golden.json` is byte-unchanged.
- No existing branch, enum member or field was removed, renamed or made
  required; every new field is `.optional()` and every new config key is
  `.optional()` with **no default**, so previously parsed configs are
  byte-identical.
- `summary()` gained exactly one conditional key (`closeReason`), which
  survives coarsening; no fine-only fact entered the summary, because §9.6
  requires a coarse fold to reproduce it.
- New event branches are **appended** to the `z.union`, never interleaved, so
  every pre-wave payload still resolves to the branch it always resolved to.

# Jul3/08 — Format Engine Extensions

Extends the stage-graph format engines
([05-formats-progression-tiebreakers.md](../05-formats-progression-tiebreakers.md) §2,
PROMPT-09) with the format shapes the idea list keeps requesting. Design only.

## 1. Motivation & scope

- **Americano / Mexicano** (21 May, ALL-CAPS urgency) — padel rotating-partner formats;
  "almost all our games are this type."
- **Custom / non-power-of-2 brackets** (7 Jan) — repechage, placement games, byes to chosen
  seeds; 6-team playoff shapes.
- **Cross-format loser drop** (4 Jul; 8 Apr) — Champions-League losers fall into Europa
  League; qualifier losers into a repechage.
- **Independent pool progression** (16 Jun ×3; 10 May; 13 June) — finish one pool and open
  its bracket without waiting for slower pools.
- **Auto-progress + early slot fill** (16 Sep ×2 auto-advance; 16 Sep ×4 / 12 Aug fill next
  match as soon as the entrant is known) — no organiser button; show a team its next
  fixture the moment it's determined.
- **More than 2 group encounters** (7 Aug ×2) — triple/quad round robin.
- **Ladder / long-run open play** (7 Nov; 8 Dec; 9 Jun) — weeks-long ladder, self-scheduled.
- **Hammes model** (20 Jan) — swiss-like "1v2, 3v4, re-rank each round, avoid rematch."
- **Assign a team into multiple phases / any prior phase** (27 Nov; 16 Sep ×3; 3 Jun) — pull
  4thA into a later match without illegal rematch.
- **Placement / final-rank from specific games** (3 Jun ×2; 17 May bracket 3/4 alphabetical
  bug) — "winner of game X = 15th place."

**In scope:** new stage `kind`s (americano, ladder) + config extensions on existing kinds
(RR legs>2, custom brackets, cross-feed, per-pool completion, auto-advance), placement
resolution. **Out:** new *sports* (Jul3/09); scheduling of these (doc 05 §2.6 handles slots).

## 2. Round-robin: legs > 2 (7 Aug)

`league`/`group` `config.legs` already exists (single/double RR, doc 02 §5). Lift the cap:
`legs: n` → circle method repeated `n` times with home/away balancing across all legs
(triple RR = 2 home/1 away split, documented). Pure change to `roundrobin.ts` (PROMPT-09
§1); property `completeness = n(n−1)/2 · legs` already generalises.

## 3. Americano / Mexicano (21 May)

A new stage kind `americano` — individuals rotate partners each round; points are personal,
not team. Config `{ courtCount, rounds, mode:'americano'|'mexicano' }`:
- **Americano**: fixed rotation so everyone partners/opposes everyone as evenly as possible
  (a resolvable combinatorial schedule, seeded).
- **Mexicano**: pairings for round r+1 derived from the round-r standings (1+4 vs 2+3
  style) — a re-rank-each-round generator, same family as Swiss `pairRound` (PROMPT-09 §2),
  so it reuses the score-group + no-rematch machinery.
Entrants are `kind:'individual'`; the round produces `pair` entrants on the fly for each
fixture. Standings are per-person points (ties into Jul3/05 fractional points).

## 4. Custom brackets & cross-format feeds (7 Jan, 4 Jul, 8 Apr)

Extend `bracket.ts` (PROMPT-09 §3):
- **Non-power-of-2**: explicit bye placement to chosen seeds (already "byes to top seeds as
  awards" — generalise to organiser-chosen byes) so 6/12/24-team brackets work; repechage =
  a second bracket fed by first-round losers.
- **Cross-format loser feed**: the fixture `feeds` wiring already has `loser_to` (doc 02
  §6). Allow `loser_to` to target a fixture in a **different stage** (CL QF loser →
  EL QF slot). Pure wiring; the progression walker already follows feeds. This is the exact
  4-Jul / 8-Apr ask.
- **Placement games** (3 Jun, 17 May): a fixture may declare `places: [15,16]` — its
  winner/loser resolve to explicit final ranks, fed into the manual-rank mechanism
  (Jul3/05 §4) instead of alphabetical. Fixes the "3rd/4th decided alphabetically" bug.

## 5. Independent pool progression & auto-advance (16 Jun, 16 Sep, 12 Aug)

Progression is already a per-division aggregate that fires "stage completed → generate next"
(doc 02 §8). Two refinements:
- **Per-pool completion**: allow a *pool* (not the whole stage) to be marked complete and
  release the fixtures that depend only on it. (Implementation note: satisfied through
  cross-stage fixture feeds + the per-decided-fixture resolver — a pool final can feed a
  dependent fixture directly, which opens the moment the pool decides while other pools
  lag. Partial resolution of *qualification specs* mid-stage stays a follow-up; the
  whole-stage completion guard is unchanged, so a cross-pool KO can never seed from a
  half-finished pool set.)
- **Auto-advance**: a division flag `auto_progress: true` fires progression automatically
  when the guard is satisfied — no organiser button (16 Sep). Emits `division_events:
  stage_auto_advanced`.
- **Early slot fill** (16 Sep ×4, 12 Aug): a bracket fixture's slot is populated the instant
  *its* feeding fixture decides, independent of sibling fixtures in the same round. The feed
  resolver runs per decided fixture, not per completed round — so a team sees its next match
  as soon as its opponent's *source* is known (partial fill shows "Winner QF1 vs TBD").

## 6. Ladder / long-run format (7 Nov, 8 Dec, 9 Jun)

New stage kind `ladder` — open standings, players issue/accept challenges over a long
window; no pre-generated full fixture list. Pairs with flexible scheduling (Jul3/04 §4
`scheduling_mode:'flexible'`, `scheduled_at=null`). Config `{ challengeRange, decayDays }`.
Result of a challenge reorders the ladder (a small ranking rule). Minimal engine surface —
mostly a standings + fixture-on-demand mode; deferred detail acceptable, flag as its own
follow-up if it grows.

## 7. Hammes model (20 Jan)

`swiss` with a config preset: `{ pairing:'rank_adjacent', avoidRematch:true }` — round 1
seeds 1v2/3v4; each subsequent round re-ranks and pairs adjacent, skipping prior opponents
(exactly the Swiss no-rematch backtracking already in `swiss.ts`, PROMPT-09 §2). So Hammes
is a named Swiss variant, not new code — document the preset.

## 8. API & entitlements

- Stage config extensions ride the existing `POST /api/v1/divisions/{id}/stages` (doc 08
  §3) — new `kind`s + config fields, validated by the format engine's schema.
- Entitlements (extends doc 10 `stages.per_division.max`, `formats.double_elim`): new
  `formats.americano`, `formats.custom_bracket`, `formats.cross_feed`, `formats.ladder`,
  `auto_progress` — group under Pro (`formats.advanced`); basic RR/KO/group+KO stays
  Community.

## 9. Edge cases

- Cross-format feed cycles → validate the stage graph is a DAG at config time (fail closed).
- Per-pool release + a cross-pool KO → KO fixtures stay TBD until all source pools done;
  never seed a bracket from a half-finished pool set.
- Americano with a court/player count that can't rotate evenly → best-effort + a `warn`
  (some pairings repeat), never silently drop a player from a round.
- Assign-same-team-multiple-phases (27 Nov): relax the "entrant used once" guard to
  per-stage; the rematch-avoidance is the generator's job (16 Sep), not a blanket block.

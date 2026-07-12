# v6/00 — Sport expansion spec (normative)

Adds engine modules `tennis`, `icehockey`, `hockey` (field). All numbers come from
`v6/01-rules-digest.md`. Implemented by PROMPT-48/49/50.

## §1 What we reuse unchanged (audit-confirmed)

- Event-sourced fold (`foldMatch`, void-resolution, monotonic decision), `score_events`
  hash chain, `match_states` cache, `nextStatus` derived-from-fold.
- `SportModule` contract (`sport/module.ts`), registry version pinning, DB catalog via
  `scripts/sync-sports.ts` (rows, not schema — **no migration**).
- Format generators (fully sport-agnostic — leagues/knockouts/swiss/americano work day
  one), scheduling board, constraints, AI scheduler (v4) — `match-length.ts` already
  carries `tennis:90, hockey:70` defaults; add `icehockey`.
- Standings: `StandingsDelta`, custom `PointsRule`, comparator registry — IIHF chain =
  `h2h_points → h2h_diff → h2h_for → diff → for → seed` (exists), FIH = standard.
- Officials system (`officials`, `fixture_officials`, role_keys, auto-assign) — only role
  presets + `officialLabel` per module are new.

## §2 New pattern A — nested scoring kernel (tennis; future padel)

`packages/engine/src/sports/nested/kernel.ts` — three-level fold with per-level win predicates:

```
NestedCfg = {
  bestOf: 3|5,
  set: { gamesTo: 6|4, winBy: 2, tiebreakAt: 6|4|3|null,   // null = advantage set
         tiebreakTo: 7|5 },
  finalSet: "same" | { matchTiebreakTo: 10|7 },             // MTB replaces deciding set
  game: { noAd: boolean },
  tiebreak: { winBy: 2 },
}
```

State: `{ sets: SetScore[], games: {home,away}, points: GamePoints, phase, serving:
"home"|"away", tbServeIndex }` where `GamePoints` is a tagged union
`standard{0|15|30|40, deuce, advantage}` | `tiebreak{n}` | `matchTiebreak{n}`.

- Events (tier 3): `tennis.point {by, meta?{ace|double_fault|winner|ue}}` — the fold
  advances point→game→set→match including deuce/adv, no-ad deciding point, TB entry at
  `tiebreakAt`-all, serve rotation (1 then 2-2 in TB; alternating games otherwise; TB
  first-server receives next set). Tier 0: `tennis.set_summary {home,away,tb?}` typed
  per set (mirrors SetbasedPad summary mode).
- `summary.headline`: `setsWon` big score; `perSide.line` speaks tennis: closed sets
  `6–4 7–6(5)`, live ` · 40–Ad` or `· TB 5–3`, serve dot on the serving side (serve
  state exposed in `detail` for pads/scorebug).
- Outcome: win only (`supportsDraws → false`). Metrics: `sets_won/lost`, `games_won/
  lost`, `points_won` → tiebreakers `set_ratio` (exists) + new `game_ratio` comparator
  (same cross-multiplied BigInt pattern as `set_ratio`).
- Variants: `tour` (bo3, TB sets, TB7), `grand-slam` (bo5, final-set TB at 6–6 to 7 —
  note real slams use 10 at 6–6; preset uses `finalSet:{matchTiebreakTo:10}` semantics
  at games level — document), `fast4` (gamesTo 4, TB at 3–3 to 5, no-ad),
  `doubles-noad-mtb10` (no-ad + match TB 10 as deciding set — the ITF doubles norm).
- **Why not extend the set-based kernel:** its state (`sets[{home,away}]` flat points)
  and win predicate (`setTo/winBy/cap`) have no game layer; bolting one on would fork
  every consumer assumption (SetbasedPad, summaries). Separate kernel keeps both simple;
  squash/pickleball later fit the *existing* set-based kernel, padel fits this one.

## §3 New pattern B — period kernel + primitives (both hockeys; football refactor)

`packages/engine/src/sports/period/kernel.ts` — generalize football's phase machine:

```
PeriodCfg = {
  periods: { count: 2|3|4, minutes: number },               // phases P1..Pn + FT
  overtime: null | { kind: "periods", count, minutes }      // football ET
           | { kind: "sudden_death", minutes, skaters? },   // IIHF OT
  shootout: null | { attempts: 5, suddenDeath: true, meta?: {clockSeconds?: 8} },
  points: { win, draw, loss, otWin?, otLoss?, shootoutWin?, shootoutLoss? },
  suspensions: SuspensionCfg | null,
}
```

- Phase events `period.advance {to}` replace `football.period` (football's `H1/H2/ET/…`
  become aliases; **football module refactors onto the kernel with byte-identical folds
  — golden-replay test over existing ledgers is the acceptance gate**).
- **Shootout primitive** (`period/shootout.ts`): extract football's best-of-5 alternating
  early-out into a shared parameterized module — reused as football pens, IIHF GWS
  (sudden-death pairs, penalty-box ineligibility recorded as flag), FIH SO (8 s attempt
  metadata).
- **Suspension track** (`period/suspensions.ts`):

```
SuspensionCfg = { classes: Record<key, {minutes|null, teamShort: boolean, recordOnly?}> }
icehockey: minor 2, bench_minor 2, double_minor 4, major 5 (teamShort) ·
           misconduct 10, game_misconduct, match (recordOnly for strength; PIM 10/20/25) ·
           penalty_shot (event → shootout-attempt fold)
hockey:    green 2, yellow 5 (teamShort — FIH teams play short on ALL cards) ·
           red (permanent, teamShort)
```

  Events `suspension.start {person?, class, clockRef?}` / `suspension.end` (explicit end
  event — engine has no clock, so expiry is recorded by the scorer/pad "release" action;
  pads show a countdown hint from `recorded_at` wall time, but the **fold only trusts
  events**, consistent with the no-clock boundary). Derived: current strength (`5v4`,
  `10v11`), PIM metric, per-player card/PIM stats, FIH progressive-escalation flag
  (prior green → suggest yellow).
- **Goals**: `goal {by, person?, assists?[0..2], kind?: fg|pp|sh|ps|pc|stroke|og,
  period}` — assists (ice), goal type (FIH corner/stroke; ice PP/SH) feed metrics.
- **Draws/OT policy**: `supportsDraws` = league-stage AND (`overtime === null` or
  explicitly allowed) — IIHF preset `iihf` (OT+GWS, 3-2-1-0 via `otWin:2, otLoss:1`),
  rec preset `recreational` (no OT, draws, 2/1/0); FIH presets `fih-outdoor`
  (4×15, draws, 3/1/0) and `fih-shootout` (SO after draw + `shootoutWin` bonus point,
  Pro-League style).

## §4 Modules

| | `tennis` | `icehockey` | `hockey` |
|---|---|---|---|
| Kernel | nested | period | period |
| Variants | tour, grand-slam, fast4, doubles-noad-mtb10 | iihf, recreational | fih-outdoor, fih-shootout, youth (4×10) |
| supportsDraws | never | rec-league only | league stages |
| Metrics | sets/games/points ratios | GF/GA/diff, PIM, PP%, player G/A/P | GF/GA/diff, cards, PC conversion |
| Tiebreak default | points → set_ratio → game_ratio → h2h → seed | points → h2h_points → h2h_diff → h2h_for → diff → for → seed (IIHF §220) | points → diff → for → h2h_points → seed |
| officialLabel.scorer | "Chair Umpire" | "Scorekeeper" | "Umpire" |
| Officials preset roles | referee, chair_umpire, line_umpire | referee ×2, linesman ×2, scorekeeper, timekeeper | umpire ×2, technical_officer, reserve_umpire |
| Fidelity tiers | 0: set summaries · 3: point-by-point | 0: final score · 1: goals-by-period · 3: full events (goals+assists+penalties) | same as ice |

## §5 UI / app wiring

- **TennisPad** (PROMPT-48): rally mode = one tap per point with spoken-score display
  (15/30/40/Ad, TB numerals), serve dot, set strip `6–4 · 3–2 (40–15)`; summary mode =
  per-set games (+TB score) typed. Registers in both dispatch points
  (`fixture-console.tsx`, `device-score-pad.tsx`) — **do not add tennis to `SETBASED`
  sets**; new `NESTED` set.
- **PeriodPad** (PROMPT-50): shared by icehockey/hockey (and future football migration):
  goal button (+scorer/assists/type sub-sheet), penalty/card button (class picker per
  `SuspensionCfg`, person, release action), period advance, OT/shootout flow (attempt
  recorder), strength chip (PP 5v4 / 10v11) always visible. Live scorebug + `/live` wall
  show strength chip + period; headline grammar: ice `2 — 1 · P3` / `(GWS 2–1)`, FIH
  `1 — 1 · Q4` / `(SO 3–2)`.
- Maps/config: `SPORT_RULES` entries (tennis: bestOf/set type/final set; hockeys:
  periods/OT/shootout/points), `PREFERRED_VARIANT` (`tennis:"tour"`, `icehockey:"iihf"`,
  `hockey:"fih-outdoor"`), `match-length.ts` add `icehockey:75`, `venue.ts` add
  `icehockey:"rink"` (tennis/hockey rows exist), sync-sports SPORT_NAMES entries.
- Seed/demo (`scripts/seed-demo.ts`): pro org gains a tennis division (tour bo3) with a
  TB set + an MTB result, and an icehockey division with an OT game, a GWS game and a
  5v4 PP goal; community org gains a FIH division with a draw + green/yellow cards
  (demo-richness house rule).

## §6 Decisions (binding)

1. **No real clock in the engine** — periods/suspensions advance by events only; elapsed
   displays are UI sugar from `recorded_at`. Keeps determinism gate intact.
2. **Football refactors onto the period kernel** with golden-replay equivalence as the
   acceptance bar; its event names and folds must not change (pinned `module_version`
   stays 1.0.0 if byte-identical, else bump minor and keep legacy fold path — decide by
   replay result).
3. **Key naming**: field hockey = `hockey` (matches existing map placeholders), ice
   hockey = `icehockey`. Rename later only with a catalog migration.
4. **Penalty-law fidelity**: modules record and derive (strength, PIM, escalation
   hints); they do **not** adjudicate coincidental/delayed-penalty law — scorer decides,
   `core.note` for context. Out of scope: full NHL/IIHF situation handbook.
5. **Shoot-out procedures** (FIH 8 s, 23 m; GWS ice conditions) are attempt metadata,
   not folded constraints.
6. **Hockey5s / indoor hockey / padel / basketball**: out of scope; digest pattern +
   kernels are built so each lands as a module + preset later (basketball = period
   kernel with quarters + points-per-goal weight — noted, not built).
7. **i18n**: pad strings follow v5 conventions if v5 has landed (console namespace);
   otherwise plain strings with a v5 follow-up note. Cross-wave dependency, not a
   blocker.

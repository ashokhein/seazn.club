# PROMPT-49 — Period Kernel + Hockeys: kernel extraction, suspensions, shootout primitive, icehockey + hockey modules

**Read first:** `v6/00-sport-expansion-spec.md` §3/§4/§6 (normative), `v6/01-rules-digest.md`
§2/§3 (every constant); `packages/engine/src/sports/football/football.ts` (phase machine +
pens to extract; refactor target), `core/events.ts` (fold kernel, postDecisionTypes),
`core/types.ts` (MatchOutcome/StandingsDelta), `competition/tiebreakers.ts` (h2h chain),
`scripts/sync-sports.ts`. Preamble: PROMPT-00. **Depends:** none. May run parallel to
PROMPT-48. **Exclusive lock on `football.ts`.**

## Task

1. **Period kernel** (`packages/engine/src/sports/period/kernel.ts`, v6/00 §3): `PeriodCfg`
   (periods count/minutes, overtime `periods|sudden_death|null`, shootout, points map
   incl. `otWin/otLoss/shootoutWin/shootoutLoss`, suspensions), phase state machine
   `P1..Pn → [OT…] → [SHOOTOUT] → FT`, goal events with `assists[0..2]` + `kind`,
   decision on phase completion or sudden-death goal.
2. **Shootout primitive** (`period/shootout.ts`): extract football's best-of-5
   alternating early-out; parameterize sudden-death pairs + attempt metadata
   (ineligibility flag, FIH 8 s). Football pens keep identical behavior through it.
3. **Suspension track** (`period/suspensions.ts`): `SuspensionCfg` classes per v6/00 §3;
   `suspension.start/end` events; derived current strength (`5v4`, `10v11`), team/player
   PIM + card metrics, FIH progressive-escalation hint (green on record → yellow
   suggested), misconduct = not short-handed, match/game-misconduct PIM values (10/20/25)
   per digest §2.
4. **Football refactor onto kernel** (v6/00 §6.2): event names, config schema and folds
   unchanged; **golden-replay test**: fold every football fixture ledger in the test
   corpus pre/post refactor → byte-identical `state/summary/outcome/StandingsDelta`.
   Keep `module_version` 1.0.0 if identical, else stop and surface (decision gate).
5. **`icehockey` module**: 3×20, OT sudden-death 5' 3v3 (config), GWS 5+SD; suspensions
   per digest §2; points `3/–/0 + otWin:2, otLoss:1` (draws only in `recreational`
   variant: no OT, 2/1/0); metrics GF/GA/diff/PIM/PP-goals + player G/A/P;
   defaultTiebreakers `[points, h2h_points, h2h_diff, h2h_for, diff, for, seed]`;
   fidelityTiers 0/1/3 (final · by-period · full events); `officialLabel.scorer:
   "Scorekeeper"`; variants `iihf`, `recreational`.
6. **`hockey` module** (field): 4×15 quarters, draws first-class, SO per digest §3
   (5 attempts, SD, 8 s metadata), suspensions green 2'/yellow 5'/red permanent — all
   `teamShort:true`; goal kinds `fg|pc|stroke` + PC-conversion metric; points 3/1/0
   (variant `fih-shootout` adds SO bonus); variants `fih-outdoor`, `fih-shootout`,
   `youth` (4×10); `officialLabel.scorer:"Umpire"`.
7. **Catalog + officials presets**: builtinModules + SPORT_NAMES (`icehockey:"Ice
   Hockey"`, `hockey:"Hockey"`), sync-sports run note (all envs); officials role presets
   per v6/00 §4 table (module `positions`/roles + seed role_keys); `match-length.ts`
   `icehockey:75`, `venue.ts` `icehockey:"rink"`.

Engine-only prompt: **no pads/UI** (PROMPT-50). Pads-less scoring still possible via
GenericPad fallback? — No: dispatch untouched means unknown keys fall to GenericPad;
acceptable interim, note in v6/README status.

## Acceptance

- Unit (kernel): phase progression 3-period and 4-quarter folds; sudden-death OT goal
  decides immediately; shootout early-out + sudden-death pairs; suspension strength math
  (two minors → 5v3; misconduct keeps 5v5; FIH yellow → 10v11), PIM totals; OT-aware
  points: reg win 3 / OT win 2 / OT loss 1 / reg loss 0 asserted through StandingsDelta;
  FIH draw yields 1/1.
- Unit (football): golden-replay corpus byte-identical (the gate); pens still fold via
  shootout primitive.
- Unit (tiebreak): icehockey default cascade validates; H2H sub-group ordering matches a
  hand-computed IIHF §220 example (3-team tie).
- E2E: create icehockey (iihf) + hockey (fih-outdoor) divisions from synced catalog;
  post raw events via API to decide one OT game and one drawn FIH game; standings show
  3-2-1-0 and draw rows correctly.
- smoke.ts: seed-path extended with one icehockey OT result asserted in standings.
- `npm test` + `tsc` green; update v6/README status.

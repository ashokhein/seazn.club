# 02 — Domain Model (Greenfield)

Replaces the v1 hierarchy (`Org → Season → Tournament → {Player, Round, Match}`), which
cannot express divisions, squads, positions, or sport variants. Everything below is the
target model; DDL lives in [07-greenfield-schema.md](07-greenfield-schema.md).

## 1. The big picture

```
Organization (tenant)
 └── Competition                 "SAFE Premier League 2026", "Spring Open"
      ├── description, branding, visibility (public dashboard, doc 09)
      └── Division ×N            "U16 Boys T20", "U18 Girls", "Open A-grade"
           ├── sport + variant  (cricket/T20 · football/11-a-side · chess/rapid)
           ├── eligibility rules (age cutoff, gender, grade)  → doc 06
           ├── Entrant ×N        team OR individual registered into this division
           │    └── RosterEntry ×N   person on the squad (position, shirt #)
           └── Stage ×M (ordered graph)     league | group | swiss | knockout | double_elim | stepladder
                ├── Pool ×K (for group stages)    "Group A", "Group B"
                ├── Round ×R
                │    └── Fixture ×F        one scheduled contest between entrants
                │         ├── Lineup (per side: selected players, positions, captain…)
                │         ├── ScoreEvent ×E   append-only event ledger (the scoresheet)
                │         ├── MatchState      derived snapshot (cache of fold(events))
                │         └── Officials, venue, scheduled_at
                └── StandingsSnapshot        derived cache per pool/stage

Person (org-scoped identity of a human)
 └── PlayerProfile      DOB, gender, photo, bio, per-sport attributes (batting style…)
Team (org-scoped, persistent across competitions)
 └── enters divisions as Entrant
```

### Renames vs v1

| v1 | v2 | Why |
|----|----|-----|
| Season | **Competition** | "Season" was a thin folder; Competition owns divisions, publishing, branding |
| Tournament | **Division** (+ its Stages) | A "tournament" conflated grouping, format and bracket into one row |
| Player (per-tournament name string) | **Person / PlayerProfile / RosterEntry / LineupSlot** | Identity vs squad membership vs match selection are different lifecycles |
| Match | **Fixture** | A fixture is scheduled; a match is what happens inside it |
| `match_events` (undo snapshots) | **ScoreEvent ledger** | Events are the source of truth, not a rescue mechanism |

## 2. Entrant abstraction — teams and individuals in one model

Chess is individuals; football is teams; badminton has singles *and* doubles. One
abstraction covers all:

```
Entrant { id, division_id, kind: 'team' | 'individual' | 'pair',
          team_id?, seed, status: registered|confirmed|withdrawn|disqualified,
          display_name, group_assignment? }
EntrantMember { entrant_id, person_id }   -- 1 row for individuals, 2 for pairs, N for teams
```

The competition engine pairs/ranks **entrants** and never cares what's inside them. The
sport module cares (a cricket lineup needs 11 + roles); it reads `EntrantMember` via the
lineup.

## 3. Persons, rosters, positions

Four distinct lifecycles — v1 collapsed all of them into `players.name`:

1. **Person** — org-scoped human identity. `{ id, org_id, full_name, dob?, gender?,
   photo, external_ref? }`. DOB drives age eligibility (doc 06). Optional link to a
   platform `user_id` (player self-service, later).
2. **PlayerProfile** — per-sport extension of a person. Sparse, sport-keyed:
   `{ person_id, sport_key, attributes jsonb }` — cricket: `{ batting: 'RHB', bowling:
   'leg-spin', wicketkeeper: true }`; football: `{ preferred_position: 'CM', foot: 'L' }`;
   chess: `{ rating: 1840, federation_id }`.
3. **RosterEntry** — person on an entrant's squad for a division:
   `{ entrant_id, person_id, squad_number?, default_position_key?, is_captain, is_keeper }`.
4. **LineupSlot** — person selected for a specific fixture:
   `{ fixture_id, entrant_id, person_id, position_key?, slot: starting|bench,
   order_no, roles? }` (order_no = batting order in cricket, board order in team
   chess; roles = catalog role keys assigned for this fixture — captain,
   wicketkeeper — so the lineup validator can enforce unique/required roles;
   added in PROMPT-03, RosterEntry keeps only the squad defaults).

### Position catalog — owned by the sport module

Positions are **sport metadata, not free text**. Each `SportModule` exports:

```ts
PositionCatalog {
  groups: [{ key: 'GK', name: 'Goalkeeper', min?: 1, max?: 1 },
           { key: 'DF', name: 'Defender' }, ...]
  roles?: [{ key: 'captain', unique: true }, { key: 'wicketkeeper', unique: true }, ...]
  lineup: { size: 11, benchMax: 7 }        // volleyball: 6 + libero rules; chess: 1
}
```

Football: GK/DF/MF/FW (+ granular CB/LB/CM/ST as child keys). Cricket: BAT/BOWL/AR/WK +
role wicketkeeper/captain. Volleyball: S/OH/MB/OPP/L with libero constraints. Chess: none
(lineup size 1). The engine validates lineups against the catalog; the UI renders pickers
from it. **Positions never affect scoring math in v2** — they are lineup/display/stats
data — but the catalog lives in the module so future stat models attach cleanly.

## 4. Sport and variant

```
Sport        { key: 'cricket', name, module_version, position_catalog, event_vocabulary }
SportVariant { sport_key, key: 't20', name: 'Twenty20', config jsonb }   -- validated by module's configSchema
```

Variants are **named config presets**, system-seeded and org-extendable:

- cricket: `t20 {overs: 20}`, `odi {overs: 50}`, `hundred {balls: 100}`, `test {innings: 2, days: 5, draws: true}`
- football: `11-a-side {half: 45}`, `futsal-style 5s {half: 20}`, `youth {half: 30}`
- volleyball: `indoor {bestOf: 5, setTo: 25, finalTo: 15}`, `beach {bestOf: 3, setTo: 21, finalTo: 15}`
- chess: `classical`, `rapid`, `blitz` (affects clock metadata, not scoring)

A division binds `(sport_key, variant_key, config_overrides)`. Merged config is validated
by the module's Zod `configSchema` at division creation — bad configs can never reach play.

## 5. Stage graph

A division's format is an **ordered list of stages with qualification edges**, not a
single enum:

```
Stage { id, division_id, seq, kind: league|group|swiss|knockout|double_elim|stepladder,
        config jsonb,                  -- rounds, legs (single/double RR), pools, bracket size, seeding policy
        qualification jsonb }          -- how entrants arrive: 'all' | {from_stage, take: [{pool_rank...}]}
```

Examples:
- Classic World-Cup: `group(pools: 4×4, legs: 1)` → `knockout(size: 8, seeding: cross-pool A1-B2)`
- v1 swiss_knockout: `swiss(rounds: N)` → `knockout(size: 4)`
- Plain league: `league(legs: 2)` — double round robin
- v1 progress_stepladder: `swiss(rounds: N)` → `stepladder(size: 4)`

The competition engine walks this graph: when a stage completes, it resolves the next
stage's qualification spec into seeded entrants and generates fixtures. Full algorithms in
[05-formats-progression-tiebreakers.md](05-formats-progression-tiebreakers.md).

## 6. Fixture and the event ledger

```
Fixture { id, stage_id, pool_id?, round_no, seq_in_round,
          home_entrant_id?, away_entrant_id?,       -- null = TBD (bracket feed) or bye
          feeds: { winner_to: {fixture, slot}, loser_to? },   -- bracket wiring
          scheduled_at?, venue_id?, court_label?, officials jsonb,
          status: scheduled|in_play|decided|finalized|abandoned|forfeited|cancelled,
          outcome jsonb?         -- MatchOutcome, denormalized after decision
        }
ScoreEvent { id, fixture_id, seq (per fixture, gapless), type, payload jsonb,
             recorded_by, recorded_at, voided_by_event_id? }
MatchState { fixture_id, last_seq, state jsonb, summary jsonb }   -- pure cache, rebuildable
```

Rules:
- **ScoreEvent is append-only.** Undo appends a `void` event referencing the target; the
  fold skips voided events. Nothing is ever deleted → the audit hash chain (migration 011
  pattern) applies directly to this table.
- `MatchState` is disposable: `fold(events)` rebuilds it. Consistency check in CI/cron.
- `status` transitions are engine-governed: `scheduled → in_play → decided → finalized`;
  `abandoned/forfeited` are terminal events with sport-defined standings consequences
  (cricket no-result = shared points; football forfeit = 3-0 award — see doc 04 §per-sport).
- `finalized` locks the ledger (only staff can reopen, audited) — separates "scoreboard
  says 3–1" from "result official".

## 7. Standings

Standings are a **derived fold** over decided fixtures, cached per (stage, pool):

```
StandingsRow { entrant_id, played, won, drawn, lost,
               points,                       -- competition points per sport/format rules
               metrics jsonb,                -- sport ledger: gf/ga/gd · runs_for/overs_faced/nrr ·
                                             --   sets_won/sets_lost/set_ratio/point_ratio ·
                                             --   buchholz/buchholz_cut1/sberger · cards/fair_play
               rank, rank_locked? }
```

The sport module contributes `StandingsDelta` per outcome; the competition engine folds
deltas and ranks via the tiebreaker cascade (doc 05 §4). Cache invalidated per decided
fixture, rebuilt transactionally.

## 8. Aggregate boundaries & concurrency

- **Fixture is the write aggregate.** One advisory lock per fixture during event append;
  event `seq` is the optimistic concurrency token (client sends `expected_seq`; mismatch
  = 409, refetch). Two scorers on one match stay consistent; two matches never contend.
- **Stage progression is a second aggregate**: `stage completed → generate next` runs
  under a division-level lock, idempotent (re-running produces identical fixtures thanks
  to deterministic generation).
- Tenant isolation: every table carries `org_id` (denormalized, trigger-filled — proven
  pattern from migration 010) with direct RLS policies.

## 9. What stays from v1

- Organization/membership/auth model — unchanged.
- Billing/subscription/entitlement tables — unchanged (extended in doc 10).
- Audit hash chain (011) — reused for `score_events` and admin actions.
- Realtime broadcast + refetch pattern (doc 10 in `development/`) — topic becomes
  `fixture:{id}` and `division:{id}` instead of `tournament:{id}`.

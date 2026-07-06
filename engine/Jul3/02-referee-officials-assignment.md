# Jul3/02 — Referee & Officials Assignment Engine

Turns the `officials.assignment` entitlement stub ([10-pro-entitlements.md](../10-pro-entitlements.md)
§Platform) into a real assignment engine. Sits beside fixture generation
([05-formats-progression-tiebreakers.md](../05-formats-progression-tiebreakers.md) §2.6,
PROMPT-09) and the scheduling console (PROMPT-17). Design only.

## 1. Motivation & scope

The single largest cluster in the idea list — organisers hand-assign officials for 85+
games and it eats hours:

- **Block-stay before break** (29 Jun) — "game1 pitch1, game2 pitch1, game3 pitch1, break"
  not pitch1→pitch2→pitch3; staying on one pitch cuts turnaround.
- **Assign to pool/group, not just division** (20 Jun; 23 May; 27 May) — "50 teams, 16
  pools; I can't open every pool"; officials only ref within their pool/group.
- **Phased auto-assign** (17 Jun ×2) — auto Phase-1 now, Phase-2 once Phase-1 known;
  "Assign is greyed out for later phases until teams are known."
- **By ranking / by result** (3 Jun ×3) — "4th in group G refs game X"; "winner of game X
  refs game Y."
- **Team-as-referee stays in division** (27 May) — coach-refs shouldn't be sent to another
  category or a distant field.
- **Judges *and* referees** (25 Dec ×2) — two official roles per fixture, separate sections.
- **Fairness caps** (29 May) — max assignments/day; distribute across whole tournament vs
  per-day.
- **Manual drag** (7 Jan) — copy/swap via modifier key; **hide ref names** publicly (25 Jun).

**In scope:** an officials model (people + roles), a pure assignment pass
(`assignOfficials`) with constraints + fairness objective, phased/result-based sourcing,
team-as-referee, API + console hooks, consent-gated public display. **Out:** the drag-drop
board mechanics themselves (PROMPT-17 owns the grid — this feeds cards into it); pay/roster
HR.

## 2. Domain model (schema delta on doc 07)

Officials are org-scoped people who may or may not be `persons` already (a team acting as
referee reuses its `entrant`). Roles are **sport-labelled** (doc 13 §labels:
Umpire/Referee/Arbiter) — reuse that catalog.

```sql
create table officials (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  person_id   uuid references persons(id) on delete set null,  -- null = standalone official
  entrant_id  uuid references entrants(id) on delete set null, -- set = team-as-referee (27 May)
  display_name text not null,
  role_keys   jsonb not null default '["referee"]',            -- ['referee','judge','scorer']
  home_pool_id uuid references pools(id) on delete set null,   -- constrain to a pool (20 Jun)
  max_per_day int,                                             -- fairness cap (29 May)
  created_at  timestamptz not null default now()
);
create index officials_org_idx on officials(org_id);

-- assignment of an official to a fixture in a role (multiple roles per fixture: 25 Dec)
create table fixture_officials (
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  official_id uuid not null references officials(id) on delete cascade,
  org_id      uuid not null,
  role_key    text not null,                 -- 'referee' | 'judge' | ...
  source      text not null default 'manual' check (source in ('manual','auto')),
  locked      boolean not null default false,-- pinned; auto pass treats as obstacle
  primary key (fixture_id, role_key, official_id)
);
```

`fixtures.officials jsonb` (doc 07) stays as the denormalized read cache; `fixture_officials`
is the write source. Public read view nulls names when `officials.hide_names` (25 Jun) —
consent filtering lives in the doc 07 note-4 views.

## 3. The assignment pass (pure, in `@seazn/engine`)

Same shape as the calendar pass (doc 05 §2.6): pure, deterministic, seeded, never silently
drops a constraint.

```ts
assignOfficials(input: {
  fixtures:  ScheduledFixture[],      // with scheduled_at, court, pool, stage
  officials: OfficialSpec[],          // role_keys, home_pool, max_per_day, entrant_id?
  locked:    FixtureOfficial[],       // pinned assignments = fixed obstacles
  policy:    AssignPolicy,
  rngSeed:   string,
}) => { assignments: FixtureOfficial[], conflicts: OfficialConflict[] }
```

`AssignPolicy`:
```ts
{ roles: ['referee','judge'],                    // required roles per fixture (25 Dec)
  poolLock: boolean,                             // official only refs own home_pool (20 Jun)
  blockStay: boolean,                            // prefer same court across a block (29 Jun)
  fairness: 'tournament' | 'per_day',            // distribution basis (29 May)
  teamRefKeepDivision: boolean,                  // 27 May
  sourcing?: RankSourcing | ResultSourcing,      // 3 Jun: by group rank / by winner-loser
  restMinMinutes?: number }                       // official can't ref two overlapping/adjacent
```

**Hard constraints** (violations → `conflict`, never assigned): no official in two fixtures
at overlapping times; team-as-referee never officiates its own fixture, never plays and
refs simultaneously (cross-check the person→entrant map, doc 05 §2.6 overlap machinery);
poolLock when set; role coverage (each required role filled or flagged).

**Soft objective** (minimise, seeded-greedy then local swap): fairness spread (variance of
per-official counts within basis), block-stay bonus (same court as official's previous
fixture in the block), travel penalty (distance between consecutive courts —
`teamRefKeepDivision` = large penalty for leaving division/field).

**Sourcing** for later stages (3 Jun, 17 Jun): officials can be *derived* from results —
`RankSourcing {fromStage, take: [{poolRank}]}` (4th of group G → official) or
`ResultSourcing {fromFixture, side: 'winner'|'loser'}`. These resolve **only when the
source stage/fixture is decided** — which is why the console can offer "auto-assign Phase 1
now, Phase 2 when Phase 1 finishes" instead of greying it out (17 Jun). The pass takes
already-resolved officials; the *sourcing resolver* (also pure) turns standings/outcomes
into an `OfficialSpec[]` for the next phase.

**Determinism/idempotence:** re-run with all outputs locked ⇒ zero moves (property, mirrors
PROMPT-17 §3).

## 4. API (extends doc 08)

```
GET/POST         /api/v1/officials                     # list/create; role_keys, home_pool, caps
GET/PATCH/DELETE /api/v1/officials/{id}
POST             /api/v1/officials/import              # bulk (reuses Jul3/01 planner shape)
POST             /api/v1/divisions/{id}/officials/auto # propose only → {assignments, conflicts}
POST             /api/v1/divisions/{id}/officials/apply# transactional persist + division_events
PATCH            /api/v1/fixtures/{id}/officials       # manual set/move/lock (drag-drop, 7 Jan)
POST             /api/v1/stages/{id}/officials/source  # resolve rank/result sourcing → specs
```

`auto` calls the engine pass with locked assignments as obstacles (same contract as
`schedule/auto`, doc 12 §4). `apply` emits `division_events: officials_assigned`. Conflict
taxonomy: `conflict.official_overlap`, `conflict.team_ref_self` block; `warn.pool_leak`,
`warn.fairness`, `warn.travel` warn (mirrors doc 12 §2 block/warn split).

## 5. Entitlements (extends doc 10)

New sub-keys: `officials.auto` (constraint solver + phased/sourcing) = Pro;
`officials.roles_multi` (judge + referee both) = Pro; manual single-role assignment
available Community (matches "basic scheduling" tier). Hidden-names is a public-read
toggle, all plans. (Implementation note: the legacy `officials.assignment` stub is left
as-is rather than "promoted" — gating manual single-role on it would contradict the
Community-manual rule in the same paragraph, so the two new sub-keys are the only gates.)

## 6. Edge cases

- Team-as-referee whose team is eliminated/withdrawn → drops from the official pool for
  later phases (sourcing resolver skips withdrawn entrants).
- Not enough officials for a slot → `conflict` surfaced, slot left empty (never
  double-book) — organiser fills manually.
- Rescheduled fixture (rain, PROMPT-17 re-flow) → its locked official moves with it; auto
  re-flow re-checks overlap.
- Break/block definition = contiguous fixtures on a court between two gaps ≥ policy break;
  block-stay optimises within a block only (29 Jun exact ask).
- Hide-names must also strip officials from `.ics` and public API, not just UI.

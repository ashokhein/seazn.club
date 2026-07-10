# Jul3/07 — Player Statistics Engine

Turns the `stats.player` entitlement ([10-pro-entitlements.md](../10-pro-entitlements.md)
§Sport depth) into a real derived-stats layer over the score-event ledger. Reads events,
writes nothing new to the truth (doc 02 §6). Design only.

## 1. Motivation & scope

- **Real-time player stats, goals + assists auto** (16 Apr; 29 Dec ×2; 10 Feb ×2; 16 Apr
  hockey points=goals+assists) — no manual post-match calculation.
- **Top scorers** (9 Jun; 25 July) — golden-boot table.
- **Player / man-of-the-match, MVP** (7 Jul ×2; 7 Jan) — award per fixture, aggregated.
- **Stats per division** (7 Jan) — separate tables per division (small top division does
  male + female MVP).
- **Stats on the front-end / referee-entered** (7 Jan) — refs pick scorer + MOTM live.
- **Player number shown when picking scorer** (9 Sep ×4; 11 Jun; 10 July; 19 May) — the
  scorer dropdown must show shirt numbers, not just names.
- **Sortable player rankings** (27 Nov ×2) — sort by any metric.

**In scope:** a per-sport stat schema, a pure aggregator folding score-events → player/team
stat tables, MOTM/award events, division-scoped leaderboards, the scorer-picker number fix.
**Out:** cross-competition ratings/Elo (doc 16 Tier 2, separate); the scoring UI itself
(doc 13 scorer console — this defines what it emits and reads).

## 2. Stats are a derived fold, never a source of truth

The ledger already carries fine-grained events (`football.goal`, `cricket.ball`,
`volleyball.rally`) gated by scoring-granularity entitlements (doc 10, doc 14). Player stats
are **another disposable projection** of those events — like `match_states` and
`standings_snapshots` (doc 02 §6–7). No new truth table; a cache:

```sql
create table player_stat_snapshots (
  division_id uuid not null references divisions(id) on delete cascade,
  person_id   uuid not null references persons(id) on delete cascade,
  org_id      uuid not null,
  sport_key   text not null,
  stats       jsonb not null,          -- sport-keyed: {goals,assists,points} / {runs,wkts,avg} / {mvp_awards}
  computed_through_seq bigint not null, -- watermark over contributing fixtures
  updated_at  timestamptz not null default now(),
  primary key (division_id, person_id)
);
```

Rebuildable at any time by refolding events → CI consistency check (same discipline as
standings, doc 02 §7).

## 3. Sport-declared stat model (plugin, like position catalog)

Each `SportModule` declares which events feed which player metrics and how to aggregate —
scoring math stays in the module; the engine just folds:

```ts
SportModule.playerStats?: {
  metrics: [{ key:'goals', label:'Goals', from:'football.goal', agg:'count' },
            { key:'assists', label:'Assists', from:'football.goal', field:'assistPersonId', agg:'count' },
            { key:'points', label:'Points', derive:(s)=> s.goals + s.assists }],  // 16 Apr hockey
  awards?: [{ key:'motm', label:'Man of the Match', from:'core.award', unique:'per_fixture' }],
}
```

- Football: goals, assists, points, cards (implemented — `football.goal` gained an
  optional `assist` field). Cricket and set sports: rally/ball events carry no person
  attribution yet (`SetBasedRally {wonBy}` is entrant-level), so their stat models are
  follow-ups once the fine events name people.
- `points = goals + assists` (16 Apr, 29 Dec) is a declared `derive` — auto, no manual sum.
- `aggregatePlayerStats(events, roster, model) → StatRow[]` is pure + deterministic.

## 4. Awards / MOTM (7 Jul, 7 Jan)

A generic `core.award {fixtureId, personId, key:'motm'}` event (append-only, undoable via
`core.void` like any event, doc 02 §6). Refs enter it from the scorer console (7 Jan
front-end ask). Aggregated into `stats.mvp_awards` and a division MOTM leaderboard. Division-
scoped so a small top division can run its own male/female MVP (7 Jan exact ask) — stats are
keyed by `division_id`.

## 5. Scorer-picker shows numbers (the most-repeated stat bug)

9 Sep (×4), 11 Jun, 10 July, 19 May: shirt numbers are stored (`entrant_members.squad_number`,
doc 07) but the goal-scorer dropdown shows only names. Fix is read-model shape: the lineup
API returns `{ personId, fullName, squadNumber }` and the picker renders `#7 — Name`
(configurable to number-order sort, 19 May). Pure UI/read change; no engine math. Documented
here because it's the top stat-adjacent complaint and belongs with the stats prompt.

## 6. API (extends doc 08)

```
POST /api/v1/fixtures/{id}/events            # core.award (MOTM) rides the existing scoring endpoint
GET  /api/v1/divisions/{id}/stats/players?metric=goals&sort=desc   # leaderboard, sortable (27 Nov)
GET  /api/v1/persons/{id}/stats?division_id=…                       # a player's card stats
GET  /api/v1/public/.../divisions/{slug}/stats                      # consent-filtered public leaderboard
```

Public stats obey consent (doc 06 §4.7 — minors' names/photos gated) via the doc 07 note-4
views. Player-profile stats on public cards = `dashboard.player_profiles` (Pro, doc 10).

## 7. Entitlements (extends doc 10)

`stats.player` (Pro) gates leaderboards + player cards + MOTM aggregation, consistent with
fine-grained scoring being Pro (doc 10 §Sport depth — stats need the fine events anyway).
The scorer-picker number display = all plans (it's a bug fix, not a feature). MOTM *entry* is
available wherever scoring is; the aggregated *tables* are `stats.player`.

## 8. Edge cases

- Voided goal event → stats refold drops it (never double-count, never strand an assist).
- Player in two teams/divisions → stats keyed per division; a cross-division total is a
  separate opt-in aggregate (touches `stats.club_championship`, doc 10).
- Own-goal / assist-less goal → `assistPersonId` optional; aggregator counts only present.
- Ball-by-ball off (Community) → coarse summaries yield team totals but not per-player;
  leaderboards show "requires detailed scoring" rather than wrong zeros.

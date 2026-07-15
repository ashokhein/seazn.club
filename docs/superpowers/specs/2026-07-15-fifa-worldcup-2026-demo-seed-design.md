# FIFA World Cup 2026 — demo seed for staging

**Date:** 2026-07-15
**Owner:** ashokhein@gmail.com
**Target:** staging DB (remote Supabase `db.hoksroegadfdfwererzu`, currently commented `REMOTE_DATABASE_URL` in `.env.local`)

## Goal

Populate staging with a realistic, fully-played FIFA World Cup 2026 as a demo competition
under `ashokhein@gmail.com`: real 48-nation draw, real fixtures + scores, real 26-man squads,
group stage → knockout, so the console board, standings, brackets, and public pages all show
authentic tournament data.

## Why the engine already fits

No engine changes needed. Verified capabilities:

- **`groups_ko` stage template** (`apps/web/src/components/v2/format-templates.ts`) — a `group`
  stage with `config.pools.count = 12` feeding a `knockout` stage.
- **`bestOfRank` qualification** (`packages/engine/src/competition/qualification.ts`) — exactly
  FIFA's "8 best third-placed teams across unequal pools", including the UEFA-style normalisation
  (drop results vs each pool's lowest-ranked member before cross-pool comparison).
- **`fifa2026` tiebreaker preset** (`packages/engine/src/sports/football/football.ts` §1.6) —
  H2H-first cascade, validated against the FIFA 2026 source.
- **`football.goal` event stream** — the same result-recording pipeline `scripts/seed-demo.ts`
  uses; a real scoreline `2–1` becomes `core.start → 2×football.goal(home) → 1×football.goal(away)
  → football.period(HT) → football.period(FT)`.

## Tournament structure to build

- **Competition:** `FIFA World Cup 2026`
- **Division:** `Main` — format `groups_ko`, `poolCount = 12`, tiebreaker preset `fifa2026`.
  - **Stage 1 — `group`:** pools A–L, 4 nations each, single round-robin = **72 matches**.
  - **Stage 2 — `knockout`:** 32 seeds via `bestOfRank` (12 winners + 12 runners-up + 8 best
    thirds) → Round of 32 → R16 → QF → SF → 3rd-place + Final = **32 matches**.
- **Entrants:** 48 national teams (team entrants).
- **Rosters:** real 26-player squads per team (~1248 persons), linked to their team entrant.
- **Results:** real scorelines re-expressed as event streams. Knockout matches not yet played at
  data-fetch time are left generated-but-unplayed; drawn knockout fixtures resolve via shootout
  events (`football` module `supportsDraws=false` in knockout).

## Data acquisition

Source: **Wikipedia** structured tables (stable, parseable) — the 2026 draw, the full
match schedule + scores, and per-nation squad pages.

Fetched data is staged into a committed JSON fixture **`scripts/data/fifa2026.json`** so the seed
is deterministic and re-runnable without hitting the web each time:

```jsonc
{
  "groups": { "A": ["MEX", "..."], "...": [] },          // 12 pools × 4 codes
  "teams": { "MEX": { "name": "Mexico", "flag": "🇲🇽" } },
  "squads": { "MEX": [{ "name": "…", "position": "GK", "shirt": 1 }] },
  "groupMatches": [{ "group": "A", "home": "MEX", "away": "…", "hs": 2, "as": 1, "kickoff": "…" }],
  "knockout": [{ "round": "R32", "home": "…", "away": "…", "hs": 1, "as": 1, "so": [4,3] }]
}
```

A one-shot builder (`scripts/build-fifa2026-data.ts`, dev-only, not part of the seed) does the
web fetches + parse and writes the JSON. Committing the JSON means the seed never depends on live
web access.

## Injection — `scripts/seed-fifa2026.ts`

Mirrors `scripts/seed-demo.ts`: drives the app HTTP API on `SEED_BASE` with cookie auth, uses
`DATABASE_URL` only to grant the org a Pro subscription (48 entrants + multi-stage exceed free caps).

1. **Auth as owner.** Log in as `ashokhein@gmail.com` against `SEED_BASE` (stg app URL).
2. **New dedicated org** "FIFA World Cup 2026" (created via API; flip subscription → `pro` via SQL).
3. `POST /api/v1/competitions` → competition.
4. `POST /api/v1/competitions/{id}/divisions` → division (football, `groups_ko`, preset `fifa2026`).
5. `POST /api/v1/divisions/{id}/entrants` → 48 team entrants.
6. `POST /api/v1/persons` per squad member; link to team entrant (roster assignment endpoint — TBD
   in plan) with position + shirt.
7. `POST /api/v1/divisions/{id}/stages` → group + knockout specs (`pools.count=12`,
   `qualification: { bestOfRank: … }`).
8. `POST /api/v1/divisions/{id}/start`; for each group fixture, replay its `football.goal` stream
   via `POST /api/v1/fixtures/{fid}/events` (using `expected_seq`).
9. `POST /api/v1/stages/{groupId}/complete` → engine resolves qualification → knockout bracket seeds.
10. Replay knockout results the same way, round by round, completing rounds so the bracket advances.

**Idempotency:** resume-safe like seed-demo — on slug/name conflict reuse the existing
competition/division and skip entrants/fixtures already present. Re-running converges to the same state.

## Verification

- **Local first:** run against local dev DB (`SEED_BASE=http://localhost:3000`), confirm in the
  console board that all 12 groups have full tables, 8 best thirds advance correctly, and the
  bracket renders through the Final.
- Unit test (per repo convention): a test over the built JSON asserting 72 group + 32 knockout
  matches, 48 teams × 26 squad members, and that `bestOfRank` seeding picks the correct 8 thirds
  from the fixture data (fails if the data file is structurally wrong).
- **Then stg:** uncomment `REMOTE_DATABASE_URL`, set `SEED_BASE` to the stg app URL, re-run;
  spot-check the public competition page.
- Help-page pass per repo convention — likely N/A (no new feature surface); confirm during plan.

## Out of scope

- No engine changes. No new API endpoints (if roster-assignment endpoint is missing, that's a
  flagged discovery in the plan, not assumed work here).
- No live-refreshing of results; the JSON is a point-in-time snapshot.
- Real player photos / bios beyond name + position + shirt number.

## Open items to resolve in the plan

- Exact roster-assignment API path (link person → team entrant with position/shirt).
- Whether `ashokhein@gmail.com` can log into stg via password, or auth must be minted via SQL/magic-link.
- Confirm stg app URL for `SEED_BASE`.
- Data-fetch volume (~50 pages): fetch inline vs. a small set of parallel fetches.

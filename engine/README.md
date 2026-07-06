# Engine v2 — Design Corpus & Implementation Prompts

The engine is the heart of the product. This folder is the **complete greenfield design**
for Engine v2: a sport-aware, plugin-based tournament engine with a separate versioned API,
a rich participant/position model, division/grade support (U16, U18, T20, …), a public
open dashboard, and an expanded Pro entitlement surface.

> **Status: implemented through PROMPT-15 (v1 cutover complete).** PROMPT-01…14 delivered
> `packages/engine`, the greenfield schema (`db/migration/V201+`, ex `schema_v2.sql`), `/api/v1`, the public
> dashboard, entitlements v2 and the simulation harness; PROMPT-15 rebuilt the organiser UI
> on v2, shipped `scripts/migrate-v1-to-v2.ts` (+ migration `013_v1_cutover.sql`) and
> **deleted the v1 engine** (`src/lib/{engine,tournament,pairing,standings,format}.ts`, the
> old `/api` tournament BFF routes and `/t/{slug}` pages — the latter now 301-redirect via
> `v1_slug_redirects`). PROMPT-16…20 remain open. Where implementation deviated, the doc
> carries a "Deviations" note (see 07) — docs and code do not drift.

## Why a rewrite

The current engine (`src/lib/engine.ts`) is sport-agnostic to a fault: every sport is
reduced to "two entrants, one winner or a draw, optional integer scores". That is fine for
a chess club night; it cannot represent:

- **Cricket** — innings, overs, wickets, Net Run Rate, DLS revised targets, super overs,
  T20 vs ODI vs 100-ball variants of the *same* sport.
- **Football** — halves, extra time, penalty shootouts, goal difference, fair-play points,
  squad positions (GK/DF/MF/FW), substitutions.
- **Volleyball** — rally scoring, sets to 25 (5th to 15), win-by-two, 3-1 vs 3-2 match
  points, set-ratio and point-ratio tiebreakers.
- **Chess** — Swiss pairing (FIDE Dutch), colour allocation, Buchholz / Sonneborn-Berger.
- **Age/format divisions** — U16 vs U18 pools inside one competition, each with its own
  fixtures, standings and eligibility rules.

Each sport has a fundamentally different *match grammar* and a different *ranking grammar*.
Engine v2 makes both pluggable.

## Core architectural decision (read this first)

**Two engines, one contract:**

1. **Match Engine** (per-sport plugin, "SportModule") — owns how a single fixture is
   scored: event vocabulary, live state machine, validity, outcome, score summary.
2. **Competition Engine** (sport-agnostic core) — owns progression: stage graphs,
   fixture generation (circle method, Swiss pairing, seeded brackets), standings folding,
   and a configurable tiebreaker cascade fed by sport-declared metrics.

Both are **pure TypeScript, zero I/O, event-sourced, deterministic** — the DB adapter
persists events and derived snapshots, never business rules.

## Document index

| # | File | Contents |
|---|------|----------|
| 01 | [01-strategy.md](01-strategy.md) | Product/engineering strategy, principles, competitive framing |
| 02 | [02-domain-model.md](02-domain-model.md) | Full domain model: sport → competition → division → stage → fixture; persons, rosters, positions |
| 03 | [03-engine-architecture.md](03-engine-architecture.md) | Package layout, SportModule contract, event sourcing, determinism, undo |
| 04 | [04-sport-scoring-specs.md](04-sport-scoring-specs.md) | Deep per-sport scoring specs + algorithms: football, cricket, volleyball, chess, badminton, table tennis, basketball, generic |
| 05 | [05-formats-progression-tiebreakers.md](05-formats-progression-tiebreakers.md) | Format engines (RR, Swiss, KO, double-elim, group+KO, stepladder, league), scheduling algorithms, tiebreaker cascade design |
| 06 | [06-divisions-and-eligibility.md](06-divisions-and-eligibility.md) | Age groups (U16/U18), format variants (T20/ODI), grades, gender, eligibility engine |
| 07 | [07-greenfield-schema.md](07-greenfield-schema.md) | Complete new PostgreSQL schema (replaces the v1 baseline, now `db/migration/V001–V028`) |
| 08 | [08-api-design.md](08-api-design.md) | Separate versioned API (`/api/v1`), public read API, API keys, OpenAPI, webhooks |
| 09 | [09-public-dashboard.md](09-public-dashboard.md) | Open dashboard: season/tournament description, schedules, player info, standings |
| 10 | [10-pro-entitlements.md](10-pro-entitlements.md) | Expanded plan matrix; which v2 features are Pro/Business |
| 11 | [11-sources.md](11-sources.md) | Research sources (FIFA, ICC, FIDE, FIVB, scheduling literature) |
| 12 | [12-scheduling-ux.md](12-scheduling-ux.md) | Scheduling UX: quick-start vs plan-first, auto-scheduler, drag-and-drop board |
| 13 | [13-roles-and-scorer.md](13-roles-and-scorer.md) | Scorer role (sport-aware labels: Umpire/Referee/Arbiter), scoped scoring, seat quotas |
| 14 | [14-score-granularity.md](14-score-granularity.md) | Score granularity ladder per sport (result → breakdown → per-player → play-by-play) |
| 15 | [15-public-discovery.md](15-public-discovery.md) | Consent-based tournament showcase on home/marketing pages + /discover directory |
| 16 | [16-future-features.md](16-future-features.md) | Post-cutover roadmap: registration & fees, offline scoring, player accounts; Tiers 2–4 backlog |

## Per-sport architecture (`sports/`)

Deep dives that extend doc 04 — one per game, each covering match model, state machine,
events, standings/tiebreakers, positions/roster, divisions interplay, and edge-case
checklists:

| Sport | File | Module |
|-------|------|--------|
| Chess | [sports/chess.md](sports/chess.md) | `boardgame` |
| Carrom | [sports/carrom.md](sports/carrom.md) | `carrom` (PROMPT-16) |
| Football | [sports/football.md](sports/football.md) | `football` |
| Cricket | [sports/cricket.md](sports/cricket.md) | `cricket` |
| Volleyball | [sports/volleyball.md](sports/volleyball.md) | `setbased` preset |
| Badminton | [sports/badminton.md](sports/badminton.md) | `setbased` preset |
| Table tennis | [sports/table-tennis.md](sports/table-tennis.md) | `setbased` preset |

## Prompt index (`prompts/`)

Ordered. Each prompt is self-contained: context, task, files, acceptance criteria.

**Status:** 00–15 ✅ implemented · 16–20 open.

| Prompt | Delivers | Depends on |
|--------|----------|-----------|
| [PROMPT-00](prompts/PROMPT-00-conventions.md) | Conventions preamble injected into every other prompt | — |
| [PROMPT-01](prompts/PROMPT-01-engine-package-scaffold.md) | `packages/engine` workspace scaffold | 00 |
| [PROMPT-02](prompts/PROMPT-02-core-types-and-events.md) | Core types, event envelope, fold/replay kernel | 01 |
| [PROMPT-03](prompts/PROMPT-03-sport-module-contract.md) | `SportModule` interface + registry + conformance test kit | 02 |
| [PROMPT-04](prompts/PROMPT-04-football-module.md) | Football sport module | 03 |
| [PROMPT-05](prompts/PROMPT-05-cricket-module.md) | Cricket module (T20/ODI/100-ball variants, NRR, DLS hook) | 03 |
| [PROMPT-06](prompts/PROMPT-06-set-based-sports-module.md) | Volleyball + badminton + table tennis (shared set-based kernel) | 03 |
| [PROMPT-07](prompts/PROMPT-07-chess-boardsports-module.md) | Chess/board-sports module + Swiss tiebreak metrics | 03 |
| [PROMPT-08](prompts/PROMPT-08-competition-engine.md) | Competition engine: stages, standings folding, tiebreaker cascade | 03 |
| [PROMPT-09](prompts/PROMPT-09-scheduling.md) | Fixture generation: circle method, Swiss pairing, brackets, calendar slotting | 08 |
| [PROMPT-10](prompts/PROMPT-10-greenfield-schema.md) | New DB schema + RLS + audit chain (drops old schema) | 02 |
| [PROMPT-11](prompts/PROMPT-11-api-v1.md) | `/api/v1` separate API + OpenAPI + API keys | 08, 10 |
| [PROMPT-12](prompts/PROMPT-12-public-dashboard.md) | Open dashboard microsite | 11 |
| [PROMPT-13](prompts/PROMPT-13-entitlements-v2.md) | Expanded Pro entitlement matrix + gates | 10 |
| [PROMPT-14](prompts/PROMPT-14-simulation-testing.md) | Property/fuzz simulation harness across all sports | 04–09 |
| [PROMPT-15](prompts/PROMPT-15-app-integration-cutover.md) | Wire app UI onto engine v2 + cutover, delete v1 | 11–13 |
| [PROMPT-16](prompts/PROMPT-16-carrom-module.md) | Carrom sport module | 03 |
| [PROMPT-17](prompts/PROMPT-17-scheduling-console.md) | Scheduling console: auto + drag-and-drop, schedule/start flows | 09, 11, 12 |
| [PROMPT-18](prompts/PROMPT-18-scorer-role.md) | Scorer role, scoped scoring console, seat quotas | 10, 11, 13 |
| [PROMPT-19](prompts/PROMPT-19-discovery-showcase.md) | Discovery: homepage showcase + /discover directory (consent-gated) | 12 |
| [PROMPT-20](prompts/PROMPT-20-tier1-features.md) | Tier-1 features: registration & entry fees (Stripe Connect), offline scoring PWA, player accounts | 15 |
| [PROMPT-21](prompts/PROMPT-21-device-links.md) | Day-of device links: account-less courtside scoring via signed fixture-scoped URLs | 13 §7, 18 |

## Jul3 feature wave (`Jul3/`)

Second design wave (designs `Jul3/00–09`, prompts `Jul3/PROMPT-21..29` — numbering
independent of `prompts/`). Status: PROMPT-21–22 implemented; 23–29 designed.

| Prompt | Design | Contents | Status |
|--------|--------|----------|--------|
| [PROMPT-21](Jul3/PROMPT-21-clubs-and-bulk-import.md) | [01](Jul3/01-clubs-and-bulk-import.md) | Clubs (parent entity, `team_display_v` badge fallback), spreadsheet import planner (`engine/import`), bulk logos, participants export | ✅ implemented |
| [PROMPT-22](Jul3/PROMPT-22-referee-officials-assignment.md) | [02](Jul3/02-referee-officials-assignment.md) | Officials entity + pure assignment pass (`engine/officials`) | ✅ implemented |
| [PROMPT-23](Jul3/PROMPT-23-schedule-undo-and-locking.md) | [03](Jul3/03-schedule-undo-and-locking.md) | Schedule undo/redo, checkpoints, safe destructive ops | designed |
| [PROMPT-24](Jul3/PROMPT-24-scheduling-constraints-v2.md) | [04](Jul3/04-scheduling-constraints-v2.md) | Constraints v2 (rest, windows, cross-person clash) + AI prose → constraints | designed |
| [PROMPT-25](Jul3/PROMPT-25-custom-points-and-standings.md) | [05](Jul3/05-custom-points-and-standings.md) | Custom points rules, carry-over, manual rank override | designed |
| [PROMPT-26](Jul3/PROMPT-26-exports-and-print.md) | [06](Jul3/06-exports-and-print.md) | DocModel exports: PDF/XLSX, scoresheets, branding | designed |
| [PROMPT-27](Jul3/PROMPT-27-player-stats.md) | [07](Jul3/07-player-stats.md) | Player statistics engine + MOTM awards | designed |
| [PROMPT-28](Jul3/PROMPT-28-format-extensions.md) | [08](Jul3/08-format-extensions.md) | RR legs>2, americano, custom brackets, cross-stage feeds, auto-advance, ladder | designed |
| [PROMPT-29](Jul3/PROMPT-29-new-sports-and-generic-scoring.md) | [09](Jul3/09-new-sports-and-generic-scoring.md) | Metric-driven generic sport module v2 + presets + combined ranking | designed |

## Ground rules for whoever implements

1. **Engine code never imports I/O.** No `postgres`, no `fetch`, no `Date.now()`, no
   `Math.random()` inside `packages/engine`. Time and ids come in via the event envelope.
2. **Every rule cites its spec section** in `04-sport-scoring-specs.md` /
   `05-formats-progression-tiebreakers.md` as a code comment.
3. **Types first** — Zod schema + inferred type before behaviour.
4. **A sport module lands only with its conformance suite passing** (PROMPT-03 kit).
5. ~~The old engine keeps running until PROMPT-15~~ — done: PROMPT-15 cut over and deleted
   v1. Historical v1 data migrates via `scripts/migrate-v1-to-v2.ts` (dry-run first; see
   the script header for the staging-rehearsal runbook), then
   `db/migration/V113__v1_cutover.sql` archives `audit_log → audit_log_v1` and drops
   the v1 tables.

# S9 — #418 (W7): career rollup — plumbing, `/me` career, public card scope

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S8's metric keys and goalkeeper metrics), then this. Server + UI session.

Branch `feat/s9-w7-career-rollup` in a fresh worktree. One PR. Issue #418.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part I, WS2 web half).

**First session in the programme with a real user-facing surface** — so it owes
all four test types, no deferrals.

## Why

Closes the web half of #407 WS2. Stats are per-division only: a player linked to
multiple sports has no career view, and the plumbing cannot resolve
entrant-attributed events to persons.

`personStats` returns a per-division list only; `/me` (`app/me/page.tsx`,
re-pin) shows per-division metric tiles and nothing cross-sport.
`recomputePlayerStats` does not build the `personsOf` context S8's models
require, so the new models never see entrant members.

## Scope

1. **Server plumbing**: `recomputePlayerStats`
   (`server/usecases/player-stats.ts`) loads lineup entrants + division config +
   entrant members to build `PlayerStatsFoldCtx.personsOf` — crediting
   `individual`/`pair` entrant members **only** — and passes the resolved `cfg`.
2. **Career rollup**: new `personCareerStats(auth, personId)` grouping snapshots
   by `divisions.sport_key`, summed via `sumPlayerStats` +
   `registry.latest().playerStats` metric metadata; exposed as `?group=sport` on
   the existing persons-stats route. `usecases/me.ts` gains
   `listMyCareerStats(userId)`.
3. **`/me` Career section** (testid `me-career`): one card per sport with metric
   tiles, per-sport variant count and matches; an empty state when a person has
   stats in zero sports. The public player card gets a per-sport rollup **scoped
   to that competition** — cross-org totals stay private to `/me`, consent
   posture unchanged.
4. **Goalkeeper metrics on the surface** (new since #418 was written — S8 ships
   them): keeper cards belong on the career view for football and both hockey
   codes. A person who kept goal in some matches and played out in others must
   read correctly, not as two half-populated cards.
5. **i18n**: new chrome keys in all 4 dictionaries; metric labels stay
   engine-declared per the existing pattern.

## Acceptance criteria

- [ ] A person in 2+ sports sees one Career card per sport on `/me` with correct
      summed metrics
- [ ] Team-entrant divisions contribute **no phantom person rows**
- [ ] Goalkeeper metrics render for a person who both kept goal and played out —
      one card, correct splits
- [ ] Public player card shows **only** competition-scoped rollups; cross-org
      totals absent — and the assertion is anchored on `="`, not a bare `data-*`
      probe (React serialises an omitted prop as `"$undefined"`, so a bare probe
      passes in both states)
- [ ] `?group=sport` documented: `npm run openapi:gen` run and `openapi/*.json`
      committed; then `i18n:gen-keys`; then `git status --porcelain` **empty**
- [ ] Career sums read **snapshots** — verify the query count; a page view must
      not trigger N recomputes
- [ ] i18n ×4 + `i18n:check` green
- [ ] Screenshots: `/me` Career at desktop **and 375px**, no horizontal page
      scroll, touch-sized targets
- [ ] `git grep -a` changed `/me` strings across `e2e/` (both phases) before merge
- [ ] Vitest counts from the JSON reporter, with the suite paths confirmed in
      `.testResults[].name` (positionals are filename filters — a typo runs a
      subset and reports green)

### Test types

- **Unit** — `sumPlayerStats` grouping, `personsOf` credit rules.
- **DB integration** — career rollup for a person in 2+ sports across 2+
  divisions, using **asymmetric** fixtures: different sports, different metric
  sets, different division counts. Two identical divisions cannot catch
  first-row-wins or wrong-group-by bugs.
- **E2E (Playwright)** — `/me` Career renders for a multi-sport person; the
  public card omits cross-org totals (anchored on `="`); desktop + 375px.
- **Smoke** — extend `scripts/smoke.ts` so the pro and free paths reach a Career
  view with at least one sport.
- **Regression** — the consent gate (cross-org absent); phantom team rows; the
  keeper split.

## Gotchas

- Recompute-on-read deletes and refolds **per division** — career sums must read
  snapshots, never trigger recomputes per page view. Assert the query count.
- Asymmetric fixtures are mandatory. Symmetric ones are the classic way this
  repo's grouping bugs survive a green suite.
- `/me` strings feed e2e — grep before merge, both phases.
- e2e on `http://127.0.0.1:PORT` 401s every API call while the browser stays
  signed in (`Secure` cookie under `NODE_ENV=production`). Use `localhost`.
- An e2e failure in the parallel phase means the serial and mobile phases
  **never ran** (`&&` chained) — fixing only the red spec ships the next one.
- Follow `seazn-local-env` for the DB and prod server. A fresh schema needs
  `db:apply` **and** `sync:sports`.

## Execution

Plumbing + route + UI interlock → **one inline implementer pass**, batching rule.
No parallel agents.

**Scout (sonnet) brief:** `server/usecases/player-stats.ts` (recompute path and
its callers), `usecases/me.ts`, the persons-stats route and its zod schema,
`app/me/page.tsx` metric-tile rendering, the public player card component and its
consent gate. file:line table only, under 25 lines, no file contents.

**Implementer (opus, high):** brief carries the scout table, S8's metric key
list from `_INDEX.md`, the consent rule (cross-org private to `/me`), and the
`="` assertion requirement. Load `frontend-design:frontend-design` before the
Career section; Playwright MCP for both breakpoints.

**Reviewer (sonnet):** does the career route trigger recomputes? Are the fixtures
asymmetric? Is the cross-org assertion anchored on `="`? Does the keeper split
come from `State` or a lineup snapshot? Gap list only.

## On close

`_INDEX.md`: S9 → DONE, the career route shape, the consent posture as shipped.
Update the help pages (`content/help/**`, English only) for the Career view.
Memory + `scripts/agent-memory-snapshot.sh`.

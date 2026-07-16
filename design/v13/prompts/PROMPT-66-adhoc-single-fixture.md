# PROMPT-66 — Ad-hoc single fixture (`addFixture`)

**Sport-agnostic.** Adding a fixture is pure competition structure — no sport
code. Works for any `SportModule`; scoring the added match uses the normal
per-sport pipeline.

**Read first:**
- `apps/web/src/server/usecases/stages.ts` — **`issueChallenge`** (~line 1326) is
  the template: it's the only on-demand single-fixture insert today (ladder-only),
  doing `insert into fixtures (stage_id, division_id, round_no, seq_in_round,
  home_entrant_id, away_entrant_id, ext_key, status) values (…, count+1, 1, …,
  'scheduled')`. Also the stage-kind guards and `snakeDistribute`/generation for
  context on how fixtures normally arrive.
- `apps/web/src/app/api/v1/stages/[id]/challenges/route.ts` — the route pattern to
  mirror (`parseBody` → usecase → `reply(201, …)`).
- `packages/engine/src/competition/standings.ts` + `stage.ts` — league/group
  standings **fold every fixture** (an extra one is additive); bracket stages
  (`isBracketStageComplete`, `bracketRanks`) are topology-driven — a loose fixture
  has no place in them.
- `apps/web/src/server/usecases/scoring.ts` + `engine-db/append-event.ts` — the
  added fixture is scored through the normal path once it exists.
- `apps/web/src/app/api/v1/fixtures/[id]/route.ts` — `PatchFixture`
  (`scheduled_at`, venue, …) already edits a fixture after creation.
- `apps/web/src/server/api-v1/schemas.ts` — add the `AddFixture` body schema.

**Depends:** none. **Migration:** none.

## Context

Fixtures only ever arrive two ways: a **stage generator** (`generate` →
round-robin / group / swiss / bracket) or **`issueChallenge`** (ladder only).
There is no way to add a single ad-hoc match to an already-running league / group
/ knockout division — needed for a **replay** of an abandoned/void match, a
one-off **extra/friendly**, a manual **tie-breaker/playoff**, or **patching a
missing fixture**. This prompt generalises the challenge insert into a guarded
`addFixture`.

## Task

### 1. `addFixture` usecase

`apps/web/src/server/usecases/stages.ts`:

```ts
export async function addFixture(auth, stageId, input: {
  home_entrant_id: string;
  away_entrant_id: string;
  round_no?: number;        // default: max(round_no)+1 for the stage
  scheduled_at?: string | null;
  venue?: string | null;
  exhibition?: boolean;     // see bracket handling
}): Promise<{ fixture_id: string }>
```

- Auth: division **write** (same gate as scoring/scheduling edits).
- Validate both entrants belong to this stage's division and are distinct.
- Insert one row mirroring `issueChallenge` (stage_id, division_id, round_no,
  `seq_in_round` = next free in that round, home/away, `status='scheduled'`,
  `schedule_source` marking it manual). Apply `scheduled_at`/`venue` if given.
- Return the new fixture id.

### 2. Stage-kind policy (the important guard)

- **league / group / swiss** → **allowed.** Standings fold every fixture, so the
  added match counts in the table (document that clearly — it's a real result,
  not cosmetic). For **group**, require a `pool_id` (or infer from the entrants'
  pool) so it lands in the right table.
- **knockout / double_elim / stepladder** → **rejected by default** (422 "can't
  add a loose fixture to a bracket — it has no slot in the tree"). Optionally
  allow `exhibition: true` to insert a **detached** fixture flagged
  `exhibition` that is **excluded from `bracketRanks`/completion** and never feeds
  another fixture — for a genuine friendly/3rd-place-style extra. If exhibition is
  out of scope for v1, just reject bracket kinds.
- **ladder / americano** → keep their existing on-demand mechanisms
  (`issueChallenge` / americano gen); `addFixture` returns 422 pointing at those.

### 3. Route + schema

- `POST /api/v1/stages/[id]/fixtures` → `addFixture` (mirror the challenges
  route). `AddFixture` zod body in `schemas.ts`.
- (Optional) a console affordance: an "Add match" action on the stage panel for
  league/group/swiss stages; out of scope if UI is deferred — the API is the core.

### 4. Interaction with completion / recompute

- Adding a fixture to a **completed** stage should re-open it or be refused
  (decide + document): recommend refusing on a `complete` stage (you'd add to an
  active stage; a replay after completion is a re-open action). Trigger the same
  standings/stats recompute the scoring path already does once the match is
  played.

## Tests (regression — each fails without its change)

- `addFixture` on a **group** stage inserts a fixture in the correct pool; once
  scored, standings include it. Same for **league**. Prove sport-neutral with a
  second sport.
- `addFixture` on a **knockout** stage → 422 (and, if implemented, `exhibition:
  true` inserts a fixture excluded from `bracketRanks`).
- Entrants not in the division / identical entrants → 422.
- Route test: `POST /stages/{id}/fixtures` returns 201 + a scoreable fixture.

## Non-goals

- No bracket surgery (re-seeding, inserting into the tree). Bracket kinds are
  rejected or exhibition-only.
- No bulk fixture add (one match per call; loop client-side if needed).
- No auto-scheduling/board placement beyond an optional `scheduled_at`.

## Help / docs pass (mandatory)

`content/help/*`: how to add a one-off match (replay, tie-breaker, friendly), that
it counts in league/group tables, and that brackets don't accept loose fixtures.
Same PR.

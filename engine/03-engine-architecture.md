# 03 — Engine Architecture

## 1. Package layout (monorepo workspace)

```
packages/engine/                     # pure TS, ZERO runtime deps except zod
  src/
    core/
      events.ts        # EventEnvelope, fold kernel, void semantics
      types.ts         # MatchOutcome, StandingsDelta, shared primitives
      errors.ts        # EngineError taxonomy (typed codes, not strings)
      clock.ts         # injected time — no Date.now() anywhere else
      rng.ts           # seeded PRNG (mulberry32) for draw-of-lots — no Math.random()
    sport/
      module.ts        # SportModule contract (§3)
      registry.ts      # register/resolve modules by key + version
      catalog.ts       # PositionCatalog types
    sports/
      football/        # one folder per sport module
      cricket/
      setbased/        # volleyball / badminton / table-tennis kernel + presets
      boardgame/       # chess + generic 1-v-1 win/draw/loss
      generic/         # fallback ≈ v1 behaviour (win_loss / score modes)
    competition/
      stage.ts         # stage state machines
      standings.ts     # fold + tiebreaker cascade executor
      tiebreakers.ts   # comparator registry (§5 of doc 05)
      qualification.ts # resolve stage→stage feeds
    scheduling/
      roundrobin.ts    # circle method
      swiss.ts         # score-group pairing
      bracket.ts       # seeded SE/DE brackets, byes, feeds
      calendar.ts      # time/venue slotting (pure constraint pass)
    testkit/           # conformance suite factories (exported for module authors)
  package.json         # "@seazn/engine", exports map per subpath
apps/web/              # current Next.js app, imports @seazn/engine
```

Root becomes an npm workspace (`package.json workspaces: ["apps/*", "packages/*"]`).
Engine builds/tests standalone: `npm -w packages/engine test`.

**Hard boundary, enforced by lint + CI:** `packages/engine` may not import `postgres`,
`next`, `ioredis`, `server-only`, or anything from `apps/`. Dependency-cruiser (or a
simple grep gate in `scripts/engine-check.ts`) fails the build otherwise.

## 2. Event sourcing kernel

```ts
interface EventEnvelope<T = unknown> {
  id: string;             // injected (uuid in prod, `e-${n}` in tests)
  fixtureId: string;
  seq: number;            // gapless, per fixture, assigned by persistence
  type: string;           // sport-namespaced: 'cricket.ball', 'football.goal', 'core.void'
  payload: T;             // validated by the owning module's eventSchema
  recordedAt: string;     // ISO, injected
  recordedBy: string | null;
  voids?: string;         // id of the event this void cancels (type === 'core.void')
}

// The only state-derivation function in the system:
function foldMatch<S>(module: SportModule<any, any, S>, cfg, lineups, events: EventEnvelope[]): S {
  const active = resolveVoids(events);          // drop voided events + the voids themselves
  return active.reduce((s, e) => module.apply(s, e), module.init(cfg, lineups));
}
```

Properties the kernel guarantees (and the testkit asserts for every module):

1. **Determinism** — `foldMatch` is referentially transparent. Same inputs → deep-equal state.
2. **Validation before append** — persistence appends an event only if
   `module.apply(currentState, event)` does not throw. Invalid events never enter the ledger.
3. **Undo = void** — appending `core.void{voids: idX}` and refolding must equal the fold
   without event X. Modules never see void events; the kernel resolves them.
   (This replaces v1's snapshot-restore undo and removes the "3 undos" budget hack —
   organisers can void any event, subject to `finalized` lock and RBAC.)
4. **Monotonic decision** — once `module.outcome(state)` is non-null, further non-void
   events are rejected except sport-declared post-decision types (e.g. `core.note`).

### Core event types (sport-independent)

| type | effect |
|------|--------|
| `core.start` | fixture `scheduled → in_play`; requires valid lineups if sport demands |
| `core.void` | cancels a prior event (undo) |
| `core.forfeit` | `{by: entrantId, reason}` → module maps to a walkover outcome |
| `core.abandon` | `{reason}` → module maps (cricket: no-result; football: replay/void per config) |
| `core.finalize` | locks ledger; competition engine consumes outcome |
| `core.note` | free-text annotation, no state effect |

## 3. SportModule contract

```ts
interface SportModule<Cfg, Ev, State> {
  key: string;                     // 'cricket'
  version: string;                 // semver; persisted on every division at creation
  configSchema: z.ZodType<Cfg>;    // variant config (overs, setTo, halfMinutes, …)
  eventSchema: z.ZodType<Ev>;      // discriminated union of the sport's event payloads
  positions: PositionCatalog;      // doc 02 §3
  variants: Record<string, Partial<Cfg>>;   // named presets: t20, odi, beach, blitz…

  init(cfg: Cfg, lineups: LineupPair): State;
  apply(state: State, ev: EventEnvelope<Ev | CoreEv>): State;   // pure; throws EngineError on invalid
  outcome(state: State): MatchOutcome | null;                    // null = still live
  summary(state: State): ScoreSummary;                           // display-ready

  standingsDelta(outcome: MatchOutcome, cfg: Cfg, ctx: StageCtx): [StandingsDelta, StandingsDelta];
  metrics: MetricSpec[];            // ledger fields this sport maintains (gd, nrr, set_ratio…)
  defaultTiebreakers: TiebreakerKey[];   // sport's official cascade (doc 05 §4)
  supportsDraws(cfg: Cfg, stage: StageKind): boolean;   // knockout football: no; test cricket: yes
}
```

```ts
type MatchOutcome =
  | { kind: 'win';      winner: EntrantId; loser: EntrantId; method?: string /* 'regulation'|'extra_time'|'shootout'|'super_over'|'dls'|'walkover'|'timeout' */ }
  | { kind: 'draw' }                                   // shared result, both progress-neutral
  | { kind: 'tie' }                                    // cricket tie ≠ draw (different points in some comps)
  | { kind: 'no_result' }                              // abandoned, points shared
  | { kind: 'award';    winner: EntrantId; score?: unknown }   // forfeit/DQ with awarded score
```

`ScoreSummary` is a structured, render-agnostic shape:
`{ headline: '252/8 (50) — 253/4 (48.2)', perSide: [...], detail?: sport-specific }` —
the UI and public API render it without knowing the sport.

### Registry & versioning

`registry.get(key, version)` — a division pins the module version at creation. Rule
changes ship as new module versions; running divisions keep replaying under the version
they started with (store `module_version` on division). Old versions stay importable until
no live division references them.

## 4. Competition engine (sport-agnostic)

Responsibilities (algorithms in doc 05):

1. **Stage lifecycle** — `draft → active → complete`; completion predicate per kind
   (all fixtures decided / N swiss rounds played / bracket final decided).
2. **Fixture generation** — delegates to `scheduling/*`; deterministic given
   (entrants, seeds, config, rng seed) so regeneration is idempotent.
3. **Standings folding** — apply `standingsDelta`s in fixture-decided order; rank with the
   tiebreaker cascade; emit `StandingsSnapshot`.
4. **Qualification resolution** — map final stage ranks into next stage's seeded slots.
5. **Progression events** — the competition layer is itself event-sourced at division
   level (`division_events`: stage_opened, fixtures_generated, stage_completed) so a
   division's structural history is replayable and auditable too.

## 5. Persistence adapter (in `apps/web/src/server/engine-db/`)

The only code that knows both the engine and Postgres:

```
appendEvent(fixtureId, expectedSeq, envelope)   -- tx: advisory lock(fixture), seq check,
                                                --  fold-validate, insert score_event,
                                                --  upsert match_state, maybe write outcome,
                                                --  audit chain, realtime publish
rebuildState(fixtureId)                          -- consistency repair / migration tool
completeStageIfReady(stageId)                    -- division lock, generate next stage
recomputeStandings(stageId, poolId?)             -- fold snapshot, cache, publish
```

All within `withTenant(orgId, …)` (RLS pattern retained from v1).

## 6. Determinism & simulation

- Ids/time/rng injected ⇒ the testkit runs **property-based tournament simulations**
  (fast-check, already a dev dep): random entrant counts, random valid event streams
  (module exports an `arbitraryEvent(state)` generator), asserting invariants:
  - fold(events) == fold(events) (purity)
  - every generated schedule: each entrant ≤1 fixture/round; RR completeness n(n−1)/2·legs
  - standings ranks are a total order; cascade is antisymmetric & transitive on samples
  - void(any event) never crashes the fold; outcome monotonicity
  - swiss: no rematch, colour balance within FIDE bounds (chess)
- Snapshot ("golden") tests per sport: canonical real-world scoresheets (a real T20
  scorecard, a real volleyball 3–2, the 2026 WC tiebreaker examples) fold to known outputs.

## 7. Error taxonomy

`EngineError{ code, message, data }` — codes: `INVALID_EVENT`, `WRONG_PHASE`,
`ALREADY_DECIDED`, `LINEUP_INVALID`, `CONFIG_INVALID`, `SEQ_CONFLICT`,
`STAGE_NOT_READY`, `ELIGIBILITY` … The API maps codes → HTTP (409/422/402) centrally;
messages are human-readable and surfaced verbatim in the UI.

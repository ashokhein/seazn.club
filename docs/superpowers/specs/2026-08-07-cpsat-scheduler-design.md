# CP-SAT scheduling service — design & investigation record

Status: investigation complete, decision leaning "build it," service not
yet scaffolded beyond the bench materials in `services/cp-sat/bench/`.
Date: 2026-08-07.

## Problem

This repo's auto-scheduler solves fixture placement with z3
(`packages/engine/src/scheduling/build-encode.ts`, `build.ts`). z3's
encoding hits a measured knee around 20,000-35,000 fixture-slots
(`fixtures.length × grid.slots.length`) at an 8s wall
(`MAX_SOLVE_ENCODING = 20_000`, `build.ts:214`, scaled to ~50,000 at
production's 20s `AUTO_SOLVER_WALL_MS`). Past that, `canSolveWithin`
(the R18 gate) rejects the board outright and the auto-scheduler falls
straight to a greedy placer — silently, no error surfaced to the
organiser.

The board that motivated this investigation — 37 fixtures, 5 courts,
30/10 minute match/gap, ~77,000 fixture-slots — sits well past that
gate and **always** falls to greedy today. z3 never even attempts it.

## Decision

Evaluate replacing only the **solve step** of the auto-scheduler with a
CP-SAT (Google OR-Tools) service, keeping grid construction, constraint
compilation, orchestration, and the greedy fallback exactly as they are
today. See "Service boundary" below for the precise split.

### Language: Python over Go

OR-Tools ships official CP-SAT bindings for C++, Python, Java, and .NET
only. Go bindings exist as unofficial community cgo wrappers around the
same native C++ core — real maintenance risk, version lag. Both
bindings call the identical native solver either way (same as z3's own
WASM build calls a native core), so this is a binding-maturity choice,
not a runtime-speed one. Python wins on maturity and ecosystem fit.

## Investigation summary

Full methodology and reasoning live in the bench script's own module
docstring (`services/cp-sat/bench/cpsat_bench.py`) — this section is
the narrative arc across several corrected passes.

### Pass 1 — encouraging, but narrower than first understood

An initial CP-SAT model (fixture×slot boolean placement, T0-only
objective, `gapMinutes=0`) cleared every board tested, including the
production shape (`OPTIMAL, 36/37, proved in 9.7s`). This result is
real, but `gapMinutes=0` is also the **only** setting z3's own official
knee measurement has ever used
(`packages/engine/scripts/bench-build.ts:100-101`, `GAP_MIN = 0`) — so
the comparison was fair, but said nothing about a realistic board.

### Pass 2 — full constraint set at a realistic gap, total collapse

Ported the remaining constraint families (T0→T3 lexicographic
objective as sequential CP-SAT solves, real court-turnaround gap,
pinned/existing rows, order-dependency) and re-benched at
`gapMinutes=10` — matching this repo's actual test fixtures (e.g.
`schedule-auto-day-spread.test.ts`). At realistic gap, the lattice
re-spaces to `gcd(matchMinutes, gapMinutes)`-minute ticks
(`build-grid.ts:100-108`), which blew the model up to ~283k boolean
variables and ~48k `AtMostOne` constraints on the production board.
Every board **collapsed to `UNKNOWN`** — zero incumbents found, not
merely unproven-optimal — including the production board given the
*entire* 20s wall dedicated to T0 alone, no competing tiers.

This was genuinely concerning, but not proof CP-SAT is worse than z3
here: z3 has never been benched at `gapMinutes>0` either. There *was*
circumstantial evidence z3 also struggles there — a mere 10-fixture/
2-court board at `gapMinutes=10` had already been observed (earlier in
this same investigation) burning the entire 20s wall and falling to
greedy.

### Pass 3 — root cause: encoding shape, not solver family

Rewrote the model from a fixture×slot boolean grid onto CP-SAT's
purpose-built scheduling primitives: one `IntVar` `start[i]` per
fixture plus `NewOptionalFixedSizeIntervalVar`s and `AddNoOverlap` per
court (turnaround gap) and per entrant (participant rest), with
existing/pinned rows folded in as plain fixed intervals in the same
`NoOverlap` families. Model size fell from **283k Bool vars / 48k
constraints to 222 vars / ~42 `NoOverlap` calls**.

Result on the production board: **`UNKNOWN` (zero incumbents) →
OPTIMAL, full T0-T3 chain, in ~2.5s** — under a third of the 8s budget.
Re-ran the full 14-point sweep (not just a spot check): v2 **strictly
dominates v1 on every point**, never worse. Correctness independently
re-verified with a hand-rolled constraint checker across all four
families (blackout, weekend, day-cap, rest/gap) — zero violations on
two different board configurations.

**Why it's faster, mechanically**: two separate effects. (1) Far fewer
objects — Python-level model construction dropped from 65.9s to 1.2s
summed across the whole sweep. (2) `AddNoOverlap` is a specialized
disjunctive-scheduling propagator (theta-tree style reasoning), not a
decomposition into weaker constraints — it infers far more per
constraint call than the general SAT engine grinding through a pile of
generic `AtMostOne` booleans.

**Remaining honest gap**: the 4-court, 140-300-fixture "knee" boards
still don't finish the full T0-T3 chain within an 8s wall — now
bottlenecked on `NoOverlap`'s own search width (not encoding size),
placed counts still improved dramatically over v1 (e.g. 159/160,
199/200 proven optimal at just the T0 tier) but the objective chain
doesn't complete. Also open: a bare-scaffolding probe (every
constraint stripped) found one narrow counter-example — pure
court-imbalance minimization (T3) with zero other constraints burned
the whole wall on the production board shape, because
`symmetry_level=0`/`cp_model_probing_level=0` (needed elsewhere to stop
presolve choking on the real constraint counts) also disables the
symmetry detection that would otherwise collapse that sub-problem's
massive interchangeable-court/entrant symmetry instantly. Not chased
further — flagged for whoever picks up solver tuning next.

### Was the existing z3 LNS repair pass a cheaper fix?

Checked separately whether this repo's own already-shipped z3 LNS
(Large Neighborhood Search) repair pass (`build.ts` section "6c. LNS",
~1675-1744) would give the production board a materially better result
than plain gate-rejected greedy, for free. **No** — confirmed by
bypassing the R18 gate directly and running z3 anyway: `encodeBuild` +
the first tier's `solver.push()` alone consume ~15.5s, nearly double
the 8s wall, before any tier check runs. At 20s, tier 1 (makespan)
starts but never finishes, so LNS's own guard
(`tiersCompleted < TIER_COUNT && elapsed() < wallMs`) never opens.
`allowLns=true` vs `false` produced byte-identical boards at both
walls. z3 cannot finish encoding this board before either wall runs
out — this is not a config/tuning gap, LNS structurally cannot fire in
time. See `packages/engine/scripts/probe-lns-gate.ts`.

This closes off "just lean on the existing free heuristic path harder"
as an option for this board shape specifically, and is the strongest
evidence for building the service: the gap is between z3 unable to
even attempt the board, and CP-SAT proving it optimal in seconds.

### Concurrency, as a side effect of the encoding change

Today's z3 path serializes every solve, across every org, on one
process (`z3-load.ts`'s `withZ3Lock`/`z3Queue` — "process-wide... a
correctness device, not a performance one," per `build.ts:989`). This
exists to contain a real hazard: z3's shared global WASM module can
enter `memory access out of bounds` and that corruption is
process-wide, poisoning every subsequent call, not just the one that
crashed. One org's large solve blocks every other org on the same
machine until it finishes.

A CP-SAT service does not need that architecture. Each request gets
its own independent `CpSolver`/model instance — no shared mutable heap
to corrupt — and OR-Tools' C++ core releases Python's GIL during the
actual solve, so multiple solves genuinely run in parallel across
threads/processes in one service instance. This is a structural
concurrency upgrade, not something to build on top. It still needs an
explicit worker-pool size and a per-org concurrency/rate cap at the API
boundary — "no lock" is not "no limit," and unbounded concurrent solves
can still starve each other on CPU/memory even without a correctness
hazard forcing serialization.

## Proposed repo structure

Additive only — nothing existing moves. `apps/web`, `packages/engine`,
root `package.json`/`pnpm-workspace.yaml`/`Dockerfile`/`fly.toml`/
`openapi/`/`db/` all stay exactly where they are (zero risk to the
existing CI/deploy pipeline, which is path-sensitive). `pnpm-
workspace.yaml` only globs `apps/*` and `packages/*`, so a `services/`
sibling needs no workspace config changes and can't collide with pnpm.

```
seazn.club/
├── apps/                                    # unchanged
│   └── web/
├── packages/                                # unchanged
│   └── engine/
│       └── scripts/
│           └── probe-lns-gate.ts            # NEW — z3 LNS dead-end diagnostic
├── services/                                # NEW top-level sibling
│   └── cp-sat/
│       ├── bench/                           # NEW — done, this investigation's artifacts
│       │   ├── cpsat_bench.py
│       │   ├── requirements.txt
│       │   └── README.md
│       ├── pyproject.toml                   # PROPOSED, not yet written
│       ├── src/
│       │   └── cp_sat/
│       │       ├── __init__.py
│       │       ├── main.py                  # gRPC server entrypoint
│       │       ├── model.py                 # v2 interval/NoOverlap model, promoted from bench/
│       │       ├── objective.py             # T0→T3 sequential-solve chain
│       │       └── schema.py                # pydantic request/response types
│       ├── tests/
│       │   └── test_model.py                # port of build.test.ts-equivalent cases
│       ├── Dockerfile                       # own image
│       └── fly.toml                         # separate Fly app, own deploy lifecycle
├── proto/                                   # NEW, PROPOSED — shared gRPC contract
│   └── scheduler.proto                      # SolveRequest / SolveResponse
├── docs/
│   └── superpowers/specs/
│       └── 2026-08-07-cpsat-scheduler-design.md   # this file
├── db/                                      # unchanged — shared schema, not a service
├── openapi/                                 # unchanged
├── package.json                             # unchanged — workspaces: apps/*, packages/*
├── pnpm-workspace.yaml                      # unchanged
├── Dockerfile                               # unchanged — web-only
└── fly.toml                                 # unchanged — web-only
```

Only `services/cp-sat/bench/` and `packages/engine/scripts/probe-lns-
gate.ts` are real, committed artifacts as of this doc. Everything else
under `services/cp-sat/` (`pyproject.toml`, `src/`, `tests/`,
`Dockerfile`, `fly.toml`) and all of `proto/` are **proposed, not yet
written** — no stub/placeholder files were created for them, since an
empty `main.py` or an undefined `.proto` message would just be
half-finished scaffolding with no real content.

Considered and rejected: nesting the entire existing JS/TS side under
`services/core/` for naming symmetry with `services/cp-sat/`. Rejected
because it would move `apps/web`, `packages/engine`, root
`package.json`/`pnpm-workspace.yaml`/`Dockerfile`/`fly.toml`/`openapi/`
— breaking every CI workflow path, Fly build-context path, and
muscle-memory command (`npm run db:apply`, etc.) for zero functional
gain; `apps/web` imports `packages/engine` the same way regardless of
nesting depth. Also rejected: `services/db/` — `db/` is shared
schema/migrations consumed by `apps/web` today, not a runtime with its
own deploy lifecycle; moving it under `services/` claims a semantic it
doesn't have.

## Service boundary — only the solve step moves

**Moves to the Python service**: model construction (the v2 interval/
`NoOverlap` model, promoted from `bench/cpsat_bench.py`'s `build_model`
into `src/cp_sat/model.py`) and the solve call itself — a direct swap
for `build-encode.ts` + `build.ts`'s z3 invocation.

**Stays in TS/Node, unchanged**:
- **Lattice/grid construction** (`build-grid.ts` — org tz, calendar-day
  math, blackout/weekend exclusion). Already correct and tested;
  serialize its output as the request payload rather than
  reimplementing tz-aware calendar math in Python.
- **AI/NLP constraint parsing** — unrelated to solving, produces the
  same `HardConstraint` objects either solver consumes.
- **Orchestration** (`schedule.ts`: `autoSchedule`, mode selection,
  `boundSolverWindow`, `withDefaultDaySpread`, cooldown, DB I/O).
- **Greedy placer/fallback** (`calendar.ts`'s `slotFixtures`) —
  unchanged contract: a Python timeout or error falls back to greedy
  exactly like a z3 gate-reject does today.

## Contract: gRPC over a shared `proto/`

Proto schema at the repo root (`proto/scheduler.proto`), owned by
neither side, giving both a compile-time-checked contract instead of a
hand-synced JSON shape:

- **TS side** (`apps/web`): `ts-proto` or `@grpc/proto-loader` +
  `@grpc/grpc-js` generates a typed client. Call site is
  `schedule.ts`'s server usecase — already Node runtime (uses `pg`, z3
  WASM), not edge, so `grpc-js`'s raw TCP/HTTP2 needs are fine.
- **Python side** (`services/cp-sat`): `grpcio-tools` generates server
  stubs from the same `.proto`.
- **Transport**: Fly's private network (6PN/WireGuard, already
  encrypted) — plain insecure gRPC channel over `<app>.internal:<port>`,
  matching the existing Fly/Supabase/Upstash infra pattern, no extra
  TLS layer needed.
- **Versioning**: proto field numbers are backward-compatible by
  construction — fields can be added without breaking the other side
  mid-rollout, which a hand-maintained JSON contract doesn't give for
  free.

Not yet drafted — the message shape should be finalized once the
constraint-family port is fully validated (rather than locking a
contract to the bench's exploratory shape).

## Open items before real service scaffolding

1. No z3 bench exists at `gapMinutes>0` for a true apples-to-apples
   baseline — unclear whether an equivalent interval-based
   reformulation would help z3 too (never attempted against it).
2. The 140-300-fixture, 4-court boards still don't finish the full
   T0-T3 objective chain within an 8s wall (bottlenecked on
   `NoOverlap` search width now, not encoding size).
3. The T3-only, zero-constraint symmetry finding (see above) — not
   chased, flagged for a future solver-tuning pass.
4. `proto/scheduler.proto` message shapes not yet drafted.
5. Worker-pool sizing and per-org concurrency/rate cap not yet decided
   — needed regardless of the encoding fix, since removing z3's
   correctness-forced serialization does not remove the need for a
   resource-fairness limit.

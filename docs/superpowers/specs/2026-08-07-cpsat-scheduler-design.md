# CP-SAT scheduling service — design & investigation record

Status: investigation complete for BUILD/POLISH (the tier solver) and REFLOW
(the repair solver); architecture, contract, and testing strategy designed for
both. Service not yet scaffolded — `services/cp-sat/` holds bench artifacts
only. This document is the spec; implementation follows via a separate plan.
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

This app has **three** scheduling modes, confirmed directly from
`schedule.ts:889-890`, and they are not one problem:

- **BUILD** ("Auto-schedule") — a fresh full pass. Ignores the current
  board, re-places every fixture. Goes to the tier solver
  (`build-encode.ts`/`build.ts`).
- **POLISH** — same tier solver as BUILD, with unlocked-only cards and
  a `frozen` set (R20). Gets whatever BUILD gets, for free, since it's
  the same code path.
- **REFLOW** ("Re-flow unlocked") — a repair operation, not a fresh
  solve. Starts from the current board (`current = placedNow +
  pinnedNow`) and finds the minimum-move fix. Goes to a **completely
  separate z3 encoding** (`repair.ts` — IntVar start/court/moved,
  ascending-k search over move count, 9 constraint families instead of
  BUILD's ~4-5). Locked cards are fixed obstacles; unlocked ones move
  only if the repair needs them to.

This document originally scoped only BUILD/POLISH. REFLOW was folded
in during the same investigation, at the owner's request, once BUILD's
service architecture was designed — the two solves share a transport,
contract shape, and deployment, but needed **independent** empirical
validation, because they are different problems with different z3
encodings.

## Decision

Replace the **solve step** of both the tier solver (BUILD/POLISH) and
the repair solver (REFLOW) with calls to a CP-SAT (Google OR-Tools)
service, keeping grid/domain construction, constraint compilation,
orchestration, and the greedy fallback exactly as they are today for
BUILD/POLISH (REFLOW has no greedy-equivalent fallback — see Open
Items).

### Language: Python over Go

OR-Tools ships official CP-SAT bindings for C++, Python, Java, and .NET
only. Go bindings exist as unofficial community cgo wrappers around the
same native C++ core — real maintenance risk, version lag. Both
bindings call the identical native solver either way (same as z3's own
WASM build calls a native core), so this is a binding-maturity choice,
not a runtime-speed one. Python wins on maturity and ecosystem fit.

## Investigation summary — BUILD/POLISH (the tier solver)

Full methodology lives in the bench script's own module docstring
(`services/cp-sat/bench/cpsat_bench.py`) — this section is the
narrative arc across several corrected passes.

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
`gapMinutes=10` — matching this repo's actual test fixtures. At
realistic gap, the lattice re-spaces to `gcd(matchMinutes,
gapMinutes)`-minute ticks (`build-grid.ts:100-108`), which blew the
model up to ~283k boolean variables and ~48k `AtMostOne` constraints on
the production board. Every board **collapsed to `UNKNOWN`** — zero
incumbents found, not merely unproven-optimal.

Not proof CP-SAT is worse than z3 here: z3 has never been benched at
`gapMinutes>0` either. There *was* circumstantial evidence z3 also
struggles there — a mere 10-fixture/2-court board at `gapMinutes=10`
had already been observed burning the entire 20s wall and falling to
greedy.

### Pass 3 — root cause: encoding shape, not solver family

Rewrote the model from a fixture×slot boolean grid onto CP-SAT's
purpose-built scheduling primitives: one `IntVar` `start[i]` per
fixture plus `NewOptionalFixedSizeIntervalVar`s and `AddNoOverlap` per
court (turnaround gap) and per entrant (participant rest). Model size
fell from **283k Bool vars / 48k constraints to 222 vars / ~42
`NoOverlap` calls**.

Result on the production board: **`UNKNOWN` → OPTIMAL, full T0-T3
chain, in ~2.5s** — under a third of the 8s budget. Full 14-point sweep
confirmed v2 **strictly dominates v1 on every point**, never worse.
Correctness independently re-verified with a hand-rolled constraint
checker across all four families — zero violations.

**Why it's faster, mechanically**: far fewer objects (Python-level
model construction dropped from 65.9s to 1.2s summed across the whole
sweep), and `AddNoOverlap` is a specialized disjunctive-scheduling
propagator, not a decomposition into weaker constraints.

**Remaining honest gap**: the 4-court, 140-300-fixture "knee" boards
still don't finish the full T0-T3 chain within an 8s wall — bottlenecked
on `NoOverlap`'s own search width, not encoding size. A bare-scaffolding
probe also found a narrow counter-example (pure court-imbalance
minimization burns the whole wall on the production shape specifically,
because the `symmetry_level=0` needed elsewhere disables symmetry
detection that would otherwise collapse it) — flagged, not chased.

### Was the existing z3 LNS repair pass (inside BUILD) a cheaper fix?

**No.** Checked by bypassing the R18 gate directly: `encodeBuild` + the
first tier's `solver.push()` alone consume ~15.5s on the production
board, nearly double the 8s wall, before any tier check runs. At 20s,
tier 1 starts but never finishes, so LNS's own guard never opens.
`allowLns=true` vs `false` produced byte-identical boards at both
walls. See `packages/engine/scripts/probe-lns-gate.ts`. **This is a
different z3 code path from REFLOW's `repair.ts`** — same English
word, unrelated subsystem; do not conflate the two when reading this
doc or its memory record.

### Concurrency, as a side effect of the encoding change

Today's z3 path serializes every solve, across every org, on one
process (`z3-load.ts`'s `withZ3Lock`/`z3Queue`) — a correctness device
against a real hazard: z3's shared global WASM module can enter
`memory access out of bounds`, corrupting every subsequent call. A
CP-SAT service does not need that architecture: each request gets its
own independent `CpSolver`/model instance, and OR-Tools' C++ core
releases Python's GIL during the actual solve, so multiple solves
genuinely run in parallel. This is a structural concurrency upgrade,
not something to build on top — but it still needs an explicit
worker-pool size and a per-org concurrency cap (see Service
Architecture below): "no lock" is not "no limit."

## Investigation summary — REFLOW (the repair solver)

Separate investigation, same rigor bar, dispatched once BUILD's service
architecture was settled. Full record: memory
`project_cpsat_reflow_repair_investigation.md`. `repair.ts` is a
different problem from BUILD entirely — no slot lattice, free
integer-minute `start`/`court`/`moved` IntVars, minimizing move count
`k` via an ascending-k search, across 9 constraint families (`window`,
`blackout`, `court`, `rest`, `person`, `order`, `order_soft`,
`instruction`, `start_window` — wider than BUILD's ~4-5).

**Result: CP-SAT decisively beats z3 at n≤250** — 16-67x faster,
verified against the real `validateAssignments()` (not a reimplemented
checker), `k` matches z3 exactly on every completed case, zero
conflicts.

| board | z3 | CP-SAT | speedup |
|---|---|---|---|
| n=20 dense | k=4, 786ms | k=4, 48ms | 16x |
| n=30 single-court chain | k=5, 1343ms | k=5, 20ms | 67x |
| n=50 dense | k=10, 10434ms | k=10, 404ms | 26x |
| n=50 sparse | k=2, 4009ms | k=2, 249ms | 16x |
| n=120 | timeout even at 180s (cited, not re-run) | k=6, 1593ms OPTIMAL | z3 can't complete this size |
| n=250 | not attempted (cited: worse than 120) | k=12, 20940ms OPTIMAL (17.2s after NoOverlap upgrade, see below) | — |
| n=500 | DRIVER-TIMEOUT (cited, not re-run) | 60s: UNKNOWN, no incumbent. 150s: FEASIBLE, k=104 vs 25 injected clashes | both fail — see Open Items |

**The investigation caught its own bug**, which is the actual reason
this result is trustworthy: an early pass reported `k=10, OPTIMAL` on
an n=50 board, but the real verifier found **20 conflicts** — a
false-clean result. Root cause: candidate-pair pruning used each
fixture's *original* position rather than its true reachable span, so
two fixtures that both moved could land adjacent with no constraint
ever posted between them (exactly the failure mode
`repair-domain.ts`'s own `FixtureDomain.span` comment warns about).
Fixed by pruning on reachable span; re-verified clean. Only caught
because the harness checked the real verifier instead of trusting the
model's own claim — the same placer/verifier-fork risk this repo's
engine has a documented history of, now also proven against an
in-progress CP-SAT port.

**Two capability questions, both answered, neither fully closed:**

- **Sub-minute moved/unmoved rounding** — `repair.ts` charges a
  different effective duration depending on whether a fixture actually
  moved (an unmoved fixture's real start may be off-minute; getting
  this wrong makes a repairable board read as clashing, or vice versa).
  CP-SAT's equivalent (a reified auxiliary IntVar sizing an optional
  interval) is built and proven correct in isolation — but every test
  board `syntheticBoard()` generates is whole-minute by construction,
  so this path has never fired against real data. Production
  `scheduled_at` is unrestricted RFC-3339, so this can occur for real.
  **Unproven, not broken.**
- **Per-family UNSAT diagnosis** — z3 asserts every constraint family
  under its own assumption literal so an UNSAT result can name which
  family blocks a repair. CP-SAT has a real, first-class equivalent
  (`add_assumptions`/`sufficient_assumptions_for_infeasibility`),
  confirmed working (two real API gotchas found and handled: assumptions
  are additive and need explicit clearing between checks; the returned
  core's literal indices are positions in the model's full internal
  variable list, not the list passed to `add_assumptions`). **Never
  exercised end-to-end on a genuinely infeasible board** — every test
  board was fully repairable this investigation.

**n=500 follow-up pass** (person/rest upgraded from pairwise-reified to
per-entrant `NoOverlap`, mirroring BUILD's own court-exclusivity fix):
no regression at 120/250 (k unchanged, 250 got 18% faster), but n=500
itself got *harder* to characterize rather than solved — 60s now finds
no incumbent at all (previously also `UNKNOWN` but with less clear
diagnostic separation), and 150s finds a **legal but k=104-vs-25-clashes**
repair. `repair.ts`'s own design philosophy states minimal movement is
a safety property, "never traded for speed" — a 104-move fix fails
this system's actual requirement even though it's conflict-free.
Suspected next cause (not isolated): the court-family reification
(O(fixtures×courts) = 2000 booleans, unchanged by this pass) or
grid-domain/search interaction at this scale. **z3 also fails at
n=500 today — this is a shared hard case, not a CP-SAT regression**,
and is carried as a disclosed open item rather than blocking this spec,
the same way BUILD's own 140-300-fixture "knee" boards are.

## Proposed repo structure

Additive only — nothing existing moves. `apps/web`, `packages/engine`,
root `package.json`/`pnpm-workspace.yaml`/`Dockerfile`/`fly.toml`/
`openapi/`/`db/` all stay exactly where they are.

```
seazn.club/
├── apps/                                    # unchanged
│   └── web/
├── packages/                                # unchanged
│   └── engine/
│       └── scripts/
│           ├── probe-lns-gate.ts            # done — z3 LNS (BUILD) dead-end diagnostic
│           └── repair-cpsat-harness.ts      # done — bridges repairSchedule()/syntheticBoard()/
│                                             #   validateAssignments() to JSON for the Python bench
├── services/                                # NEW top-level sibling
│   └── cp-sat/
│       ├── bench/                           # done — investigation artifacts
│       │   ├── cpsat_bench.py               # BUILD/POLISH model
│       │   ├── cpsat_repair_bench.py        # REFLOW model
│       │   ├── requirements.txt
│       │   └── README.md
│       ├── pyproject.toml                   # PROPOSED, not yet written
│       ├── src/
│       │   └── cp_sat/
│       │       ├── __init__.py
│       │       ├── main.py                  # gRPC server entrypoint (grpcio, sync)
│       │       ├── build_model.py           # BUILD/POLISH interval/NoOverlap model, promoted from bench/
│       │       ├── build_objective.py       # T0→T3 sequential-solve chain
│       │       ├── repair_model.py          # REFLOW model, promoted from cpsat_repair_bench.py
│       │       ├── config.py                # env-driven settings (PORT, MAX_WORKERS, wall bounds, secret)
│       │       └── schema.py                # message (de)serialization + defensive validation
│       ├── tests/
│       │   ├── test_build_model.py
│       │   ├── test_repair_model.py
│       │   └── test_server.py               # in-process grpc server test, real stub, no network
│       ├── Dockerfile                       # own image
│       └── fly.toml                         # separate Fly app, own deploy lifecycle
├── proto/                                   # NEW, PROPOSED — shared gRPC contract
│   └── scheduler.proto                      # see Contract below — field tables here, not yet .proto text
├── .github/workflows/
│   └── cp-sat-service.yml                   # PROPOSED — path-filtered on services/cp-sat/**, proto/**
├── docs/
│   └── superpowers/specs/
│       └── 2026-08-07-cpsat-scheduler-design.md   # this file
├── db/                                      # unchanged
├── openapi/                                 # unchanged
├── package.json                             # unchanged — workspaces: apps/*, packages/*
├── pnpm-workspace.yaml                      # unchanged
├── Dockerfile                               # unchanged — web-only
└── fly.toml                                 # unchanged — web-only
```

Considered and rejected: nesting the existing JS/TS side under
`services/core/` (breaks every CI/Fly/muscle-memory path for zero
functional gain); `services/db/` for shared schema (not a runtime with
its own deploy lifecycle).

## Service boundary — only the solve step moves

**Moves to the Python service**: model construction (BUILD/POLISH's
interval/`NoOverlap` model, REFLOW's move-minimizing model) and the
solve call itself.

**Stays in TS/Node, unchanged**:
- **Lattice/grid construction** (`build-grid.ts` for BUILD/POLISH,
  `repair-domain.ts` for REFLOW) — org tz, calendar-day math,
  blackout/weekend exclusion, already correct and tested. Serialized
  as the request payload rather than reimplementing tz-aware calendar
  math in Python.
- **AI/NLP constraint parsing** — unrelated to solving, produces the
  same typed rule objects either solver consumes. Confirmed orthogonal
  to the `ai-schedule-gap` product programme (joint apply/undo,
  credit/quote integrity, officials auto-run — a different layer
  entirely, connects only through this same solver-agnostic interface;
  that programme is CLOSED as of 2026-08-05, no file overlap with
  anything in this document).
- **Orchestration** (`schedule.ts`: mode selection, wall bounding, DB
  I/O).
- **Verification, unconditionally** — `validateAssignments` runs once,
  generically, over whichever engine's board it's handed
  (`build.ts:705`). CP-SAT is a placer, exactly like greedy and z3 are
  placers today; TS remains the **only** verifier and the only source
  of `conflicts`/`metrics`/`moved`/`lost`. This is the direct,
  deliberate fix for the placer/verifier-fork bug class already on
  record in this repo's engine history — one verifier, now three
  placers (greedy, z3, CP-SAT) instead of two.
- **Greedy placer/fallback** (`calendar.ts`'s `slotFixtures`) — for
  BUILD/POLISH, unchanged contract: a Python timeout or error falls
  back to greedy exactly like a z3 gate-reject does today. **REFLOW has
  no greedy-equivalent fallback** — see Open Items.

## Service architecture — framework & concurrency model

The Python-side framework question ("what's the Flask-equivalent
instinct here") has one hard constraint first: Flask cannot serve gRPC
at all — it's WSGI, HTTP/1.1 only, no HTTP/2 trailers. Three real
options were compared:

1. **`grpcio` (official, sync API) + bounded `ThreadPoolExecutor` — chosen.**
   Reference implementation, `grpcio-tools` for codegen, official
   `grpc_health.v1` health-check package. Concurrency unit = pool
   thread; OR-Tools' CP-SAT solve releases the GIL during the actual
   C++ solve (see Concurrency above), so N threads genuinely
   parallelize N solves with no event loop required. `max_workers`
   becomes the literal, explicit answer to worker-pool sizing — a hard
   cap, not a suggestion.
2. **`grpc.aio` (asyncio) + `ProcessPoolExecutor` for the solve —
   rejected.** Async only pays off for many concurrent lightweight
   I/O-bound calls; this service has none of that shape (no DB, no
   fan-out, just "take a board, solve it"). The blocking OR-Tools call
   would still need offloading to a process pool, throwing away the
   GIL-release parallelism option 1 gets for free and adding pickling
   overhead across the process boundary. Extra complexity, no measured
   benefit on this workload.
3. **Connect-RPC — rejected.** Its payoff (gRPC-Web/plain-HTTP-JSON for
   free) matters when a browser needs to call the service directly.
   Nothing here does — `apps/web`'s server-side route is the only
   caller, and gets a real gRPC client via `grpc-js` either way.
   Connect's server-side maturity is strongest in Go/TS, weakest in
   Python — the side that matters here.

**Worker-pool sizing and per-org fairness** (resolves the prior open
item #5): `max_workers` on the `ThreadPoolExecutor` is the flat
concurrency cap for v1. No per-org priority or rate fairness beyond
FIFO queuing at the pool boundary — deliberately the simplest version;
a per-org cap is a named v2 concern (see Open Items), not solved here,
to avoid building fairness infrastructure before there's evidence one
org actually starves another.

## Contract: gRPC over a shared `proto/`

Proto schema at the repo root (`proto/scheduler.proto`), owned by
neither side. **Specified here as field tables — the literal `.proto`
IDL text is written during implementation, not this spec**, so the
schema isn't locked before the design that shapes it is approved.

- **TS side** (`apps/web`): `ts-proto` or `@grpc/proto-loader` +
  `@grpc/grpc-js` generates a typed client. Call site is `schedule.ts`'s
  server usecase — already Node runtime, not edge.
- **Python side** (`services/cp-sat`): `grpcio-tools` generates server
  stubs from the same `.proto`.
- **Transport**: Fly's private network (6PN) — WireGuard-encrypted,
  `<app>.internal:<port>` DNS, no extra config needed between apps in
  one org.
- **Versioning**: because `proto/` lives in the **same monorepo** as
  both callers, there is no independent-deployment version-negotiation
  problem a public API would have. Additive-only field numbers by
  convention; a breaking change is a same-PR change to both sides, not
  a runtime negotiation.

### RPC surface

One RPC per problem shape, plus standard health checking. Kept as two
methods rather than a `mode` oneof on one method, because the request
shapes diverge enough (BUILD/POLISH carries a slot grid; REFLOW carries
free-domain fixtures with an original position) that a shared envelope
would mostly be unused fields on one side or the other:

- `SolveBuild(SolveBuildRequest) returns (SolveBuildResponse)` — unary.
  Serves BUILD and POLISH identically (POLISH is BUILD with a `frozen`
  set already folded into the request's existing/pinned rows —
  no service-side distinction needed).
- `SolveRepair(SolveRepairRequest) returns (SolveRepairResponse)` —
  unary. Serves REFLOW.
- `grpc.health.v1.Health/Check` — standard readiness/liveness.

No streaming RPC (both target 8-10s / repair's own budget — a progress
stream only pays off for much longer solves than either target). No
request caching or idempotency (every call is a fresh solve; not
exploited in v1).

### Tier/objective semantics are a fixed protocol constant, not wire data

BUILD/POLISH's T0→T3 chain (T0 max-placed → T1 makespan → T2 worst idle
gap → T3 court imbalance, confirmed by reading `build.ts` directly —
not guessed) and REFLOW's move-count minimization are solver-native
code, not data — they cannot be serialized as a generic "objective
function" across the wire. Both sides implement the same four BUILD
tiers, in the same order, natively in each solver's own idiom; the
contract names them as a shared constant versioned alongside the proto
itself, and does not attempt to parameterize objective logic as a
message field.

### `SolveBuildRequest`

| field | type | notes |
|---|---|---|
| `request_id` | string | correlation id for logs only — **not** an idempotency key, no caching implied |
| `courts` | repeated string | court identifiers |
| `grid` | message `Grid { repeated Slot slots (court, start_at_ms); step_minutes }` | TS-computed lattice; Python treats it as an opaque legal-slot set, no calendar/tz math on that side |
| `fixtures` | repeated `Fixture` | solve-relevant subset of `SchedulableFixture` only, not the full DB row |
| `existing` | repeated `Assignment (fixture_id, court, start_at_ms)` | immovable rows — pins and seed pins already folded in by TS per `BuildGridInput` |
| `dependencies` | repeated `OrderPair (before_fixture_id, after_fixture_id)` | |
| `constraints` | message | `match_minutes`, `gap_minutes`, per-division `min_rest_minutes`/`max_fixtures_per_day` — blackout/weekend already baked into `grid`, not restated |
| `wall_seconds` | double | server-clamped to the 8-10s target regardless of what's requested — authoritative, not advisory |

No `enabled_tiers` field — v1 always attempts all four tiers in order,
budget-permitting, matching z3's existing behavior exactly. Partial-tier
selection is unnecessary complexity not asked for by anything measured.

### `SolveBuildResponse`

| field | type | notes |
|---|---|---|
| `assignments` | repeated `Assignment` | the only thing TS strictly needs to re-run its own verifier |
| `status` | enum `OPTIMAL \| FEASIBLE \| INFEASIBLE \| UNKNOWN \| ERROR` | CP-SAT's own native `CpSolverStatus` vocabulary — see translation table below |
| `tiers_completed` | int32 | same semantics as `BuildResult.tiersCompleted` |
| `objective_values` | repeated `Tier { name, value_ms }` | per-tier achieved bound, for logging/parity against z3's own numbers |
| `elapsed_ms` | int64 | |
| `wall_exhausted` | bool | same semantics as `BuildResult.budgetExpired` |
| `error` | message `{ code, message }` | populated only when `status=ERROR` — distinct from `INFEASIBLE` (a real solver verdict) |

### `SolveRepairRequest`

| field | type | notes |
|---|---|---|
| `request_id` | string | correlation id only |
| `courts` | repeated string | currently configured courts — **not necessarily every court referenced by `fixtures`**, see the court-removal note below |
| `fixtures` | repeated `RepairFixture (fixture_id, original_court, original_start_ms, duration_ms, entrant_ids, division_id, locked)` | `original_court` may be absent from `courts` (see below) |
| `families` | message | the 9 `REPAIR_FAMILIES` inputs: window, blackout, court, rest, person, order, order_soft, instruction, start_window |
| `wall_seconds` | double | server-clamped |

**Domain-construction note, found while answering an unrelated product
question, not during the bench itself**: z3's real repair solver
builds each fixture's court domain as `{original_court} ∪ {configured
courts}` (`repair.ts:465-470`) — a fixture's original court is always
legal for it, whether or not it's still in `config.courts`. This is
what lets REFLOW legally leave a fixture on a court an organiser just
removed from settings, since moving it costs `k` and REFLOW minimizes
moves. **The CP-SAT port must replicate this exact domain construction
or it will silently diverge from z3's behavior on this case** — this is
an implementation-fidelity requirement, not a new open item, and is
called out here so it isn't lost between this spec and the plan.

### `SolveRepairResponse`

| field | type | notes |
|---|---|---|
| `assignments` | repeated `Assignment` | |
| `k` | int32 | number of fixtures moved — the primary metric, not a byproduct |
| `status` | enum `OPTIMAL \| FEASIBLE \| INFEASIBLE \| UNKNOWN \| ERROR` | same native vocabulary as `SolveBuildResponse` |
| `blocking_family` | optional string | populated only on a diagnosed `INFEASIBLE`, naming which of the 9 families blocks the repair — see capability B in the investigation summary; **the end-to-end path producing this field is unproven**, ship the field, do not assume it always populates correctly until tested |
| `elapsed_ms` | int64 | |
| `wall_exhausted` | bool | |
| `error` | message `{ code, message }` | |

### Status vocabulary translation — owned by TS, not the contract

CP-SAT's native status (`OPTIMAL/FEASIBLE/INFEASIBLE/UNKNOWN/ERROR`) is
deliberately narrower than the existing `BuildStatus` union
(`already_optimal`/`verifier_rejected`/`z3_unavailable`/`not_searched`/
`solver_busy` — several of these are TS-side or z3-specific concepts
with no CP-SAT equivalent). `schedule.ts` owns the mapping; the contract
does not pre-translate. Exact mapping (e.g. does CP-SAT's `UNKNOWN` map
to `not_searched`, does `ERROR` map to `z3_unavailable`'s slot or a
renamed generic value) is implementation work informed by the UI/wire
section below, not a contract-level decision.

## Internal communication — auth & transport

**Auth**: shared-secret gRPC metadata, mirroring
`apps/web/src/lib/peer-revalidate.ts`'s existing convention exactly (a
distinct new secret, e.g. `CPSAT_SERVICE_SECRET` — not reusing
`CRON_SECRET`, different trust boundary). A grpcio server interceptor
rejects with `UNAUTHENTICATED` before the RPC handler runs if the
metadata entry is missing or wrong.

**mTLS — considered, rejected.** Fly 6PN is already WireGuard-encrypted
and not internet-reachable. mTLS would add real operational cost (cert
issuance/rotation, an internal CA) for a threat model this repo doesn't
defend against anywhere else internally. Shared-secret matches the
existing risk posture and precedent.

**Timeouts**: TS client sets a gRPC deadline = `wall_seconds` + a fixed
margin (~2s), so the client gives up slightly after the server's own
authoritative cap would have returned anyway. Deadline-exceeded or
transport error on BUILD/POLISH → fall back to greedy, same contract as
today's z3 gate-reject. **REFLOW has no fallback engine to fall back
to** — see Open Items.

**Retries**: none by default. A solve is seconds of CPU, not a cheap
idempotent GET — a blind retry on timeout just burns another full wall
for no evidence of a different outcome. A transport-level connection
error (`UNAVAILABLE`, not `DEADLINE_EXCEEDED`) may retry once via
gRPC's own `service_config` retry policy.

## Deployment

Own Fly app, own `Dockerfile`/`fly.toml`, `lhr` region to match the web
app (minimize inter-machine latency inside Fly's network). Recommending
**`min_machines_running=1`** (always warm), not scale-to-zero — a cold
start (Fly machine boot, ~1-3s) would eat directly into the 8-10s wall
budget this entire investigation was built around; this service has a
different latency shape than the always-on web app's own
`min_machines_running=2` (deploy overlap + matchday headroom), so that
value should not be copied blindly.

## CI

New path-filtered workflow (`cp-sat-service.yml`), triggered only on
changes under `services/cp-sat/**` and `proto/**` — mirrors this repo's
existing PR-only, path-sensitive CI culture (smoke CI is PR-only
already; this follows the same reasoning). Runs the standalone pytest
suite on every PR touching those paths, never on unrelated PRs.
Statelessness (no DB, no Flyway ceremony) makes integration-in-CI cheap
enough to include rather than defer — a real advantage over most of
this repo's CI, which gates expensive suites to PR-only specifically
because standing up a DB is not cheap.

## Testing strategy

**Standalone** (Python-only, zero Node/DB — the explicit ask this spec
was written to satisfy): `cd services/cp-sat && pytest`. In-process
gRPC server via grpc's own testing channel — no real socket, no other
part of the repo running. Reuses the bench's already-validated
hand-rolled constraint checker and proof boards (BUILD's n=20 five-family
board, REFLOW's small verified boards) as real fixtures rather than
inventing new ones.

**Integration** (real TS client → real running Python process):
- A regression test asserting on the actual production board from the
  BUILD investigation (37×5, ~77k slots, expect OPTIMAL/35-37 placed) —
  doubles as a guard on the finding itself, not just the wiring.
- A **parity test**, in the same spirit as `build-encode-parity.test.ts`:
  CP-SAT's output run through the real `validateAssignments`, zero
  conflicts required. This is the actual correctness gate — not Python
  agreeing with itself, but TS and Python agreeing on what's legal.
  Applies to both `SolveBuild` and `SolveRepair` results.
- A **fallback-path test** for BUILD/POLISH: service down → clean
  greedy fallback, no error surfaced, matching today's z3-unavailable
  contract. **REFLOW has no equivalent test to write yet**, because it
  has no fallback engine — see Open Items.
- A local dev recipe (new section in the `seazn-local-env` skill, or a
  `services/cp-sat` README section): start the Python service, point
  the TS integration test at `localhost:<port>` via an env override —
  plain commands, matching this repo's existing non-docker-compose
  local-env convention rather than introducing a new tool.

## UI / wire-surface impact

Checked directly against the actual components, not assumed. The
schedule board (`result-strip.tsx`) has an `ENGINE_KEY` map
(`greedy`/`z3`/`z3+lns`) and a `statusKey()` switch keyed on
`already_optimal`/`solver_busy`/`z3_unavailable`/`not_searched`, each
with deliberate, tested copy (e.g. `solver_busy` promises a retry might
help, `z3_unavailable` does not).

**The visible copy is already engine-neutral** — checked all 4 locale
dictionaries: `board.result.engine.z3` renders as "Solver" (EN),
"Solveur" (FR), "Solucionador" (ES), and the equivalent in NL. No
user-facing string anywhere says "z3". Only the i18n **key names** and
the TS union's wire values (`"z3"`, `"z3+lns"`) carry the name, and
those are invisible to organisers.

**Decision needed during implementation, not this spec**: keep `"z3"`/
`"z3+lns"` as opaque legacy wire-values once CP-SAT is what's actually
running (zero UI/test blast radius, just a stale-looking internal tag),
or do a scoped rename. A rename touches the `ENGINE_KEY` map, all 4
dictionaries, at least 6 test files pinning literal `engine: "z3"`
fixtures (`ai-diff-repair-strip.test.tsx`, `result-strip-wiring.test.tsx`,
`result-strip.test.tsx` (×multiple), `schedule-board-polish.test.tsx`),
and an e2e regex a comment states "accepts all three" engine values.
Not free, not large either — a bounded, scoped follow-up either way.

## Target wall budget for BUILD/POLISH: ~8-10s

**This is a target for the CP-SAT service once built — NOT a change to
`apps/web`'s live `AUTO_SOLVER_WALL_MS`** (currently 20s, z3 — different
solver, findings don't transfer, and that value was deliberately raised
this same investigation via commit `47208f3d`).

`max_time_in_seconds` is a ceiling, not a fixed duration. Measured
directly: the production board converges in 2.4s at a 5s wall,
identically at 8/20/30s tested elsewhere. The two boards that don't
converge (knee-140×144, knee-160×216) got **zero additional tiers
completed between a 15s and a 30s wall** — doubling the wall bought
nothing measurable. So 8-10s captures 100% of the observed benefit for
BUILD/POLISH; REFLOW's own budget is a separate, smaller-board problem
(see the REFLOW investigation summary — its size tiers top out at 500,
not BUILD's ~77k-slot scale, and its wall is per-repair, not per-board).

## z3 removal scope

**"Remove all z3 code" is not accurate for this spec — "remove all z3
code the BUILD/POLISH path owns" is.** Confirmed directly, not assumed:
`schedule.ts:889-890` — "BUILD and POLISH go to the tier solver...
REFLOW goes to the repair solver." Two structurally separate z3 call
sites:

- **BUILD/POLISH** — `build-encode.ts`, `build.ts`'s tier-solver and
  LNS sections, `build-lns.ts`, the R18 `canSolveWithin`/
  `MAX_SOLVE_ENCODING` gate. **Removable once CP-SAT bakes in for this
  path** — fully investigated, fully covered by this spec.
- **REFLOW** — `repair.ts`, `repair-domain.ts`, `repair-decompose.ts`,
  `repair-minimality.ts`, `repair-synthetic-board.ts`, own 6-file test
  suite. **Not removable on the same timeline** — n=500 remains an open
  item, and REFLOW has no fallback engine (see below), so cutover here
  needs its own decision separate from BUILD/POLISH's.
- **`z3-load.ts`** (WASM loader + lock) is shared by both paths —
  stays regardless of BUILD/POLISH's cutover, since REFLOW still needs
  it until its own cutover is separately decided.

## Open items before real service scaffolding

1. No z3 bench exists at `gapMinutes>0` for BUILD, for a true
   apples-to-apples baseline at that setting (carried over, unchanged).
2. The 140-300-fixture, 4-court BUILD boards still don't finish the
   full T0-T3 chain even at a 30s wall — needs solver-craft, not
   patience (carried over, unchanged).
3. The T3-only, zero-constraint symmetry finding for BUILD — low
   priority, bare-scaffolding artifact, the real constrained model
   never exhibits it (carried over, unchanged).
4. ~~`proto/scheduler.proto` message shapes not yet drafted~~ —
   **resolved above** (field tables; literal `.proto` text is
   implementation work).
5. ~~Worker-pool sizing and per-org concurrency cap not yet decided~~ —
   **resolved above** (`max_workers` flat cap; per-org fairness is a
   named v2 concern, not solved in v1).
6. **REFLOW n=500** — precisely characterized, not closed (see REFLOW
   investigation summary). Not blocking, since z3 also fails here
   today.
7. **REFLOW capability A** (sub-minute moved/unmoved rounding) —
   machinery correct in isolation, unproven against real off-minute
   production data.
8. **REFLOW capability B** (per-family UNSAT diagnosis) — mechanism
   verified, full end-to-end relaxation path unproven on a genuinely
   infeasible board.
9. **REFLOW hard-rule coverage** (`min_rest_minutes`,
   `max_fixtures_per_day`) — zero test coverage, inherited from
   `repair-synthetic-board.ts`'s own existing gap, not extended past it.
10. **REFLOW blackout coverage** — z3's repair solver fully supports
    blackout as a first-class family today (`repair.ts:476-479`); the
    CP-SAT bench never exercised it, because `repair-synthetic-board.ts`
    hardcodes `blackouts: []` on every generated board. Real capability
    exists in z3; CP-SAT side is unverified, not unsupported.
11. **REFLOW has no fallback engine.** BUILD/POLISH's contract is
    "Python fails → fall back to greedy," and greedy is a legitimate,
    if lower-quality, answer to "place these fixtures." REFLOW's job is
    "make the smallest possible change to fix this specific board" —
    there is no equivalent cheap fallback that preserves the
    minimal-movement safety property greedy doesn't understand.
    **What REFLOW does when the Python service is down or times out is
    an undecided product question, not an engineering detail** — needs
    an explicit owner decision before REFLOW can cut over, independent
    of BUILD/POLISH's cutover.
12. ~~z3 rollout/cutover mechanics for BUILD/POLISH~~ — **resolved:
    straight cutover, greenfield.** No feature flag, no dual-run
    comparison period, z3 not kept as a secondary fallback ahead of
    greedy. Once CP-SAT passes its verification bar (parity tests +
    the production-board regression test, both in Testing Strategy
    above), it becomes the only solve path for BUILD/POLISH in the
    same wave that removes `build-encode.ts`/`build.ts`'s tier-solver
    and LNS sections — greedy remains the only fallback, unchanged.
    **Does not extend to REFLOW** — REFLOW's own cutover stays gated on
    items 6-11 above, in particular item 11 (no fallback engine
    decided yet). A "straight, greenfield" cutover posture doesn't
    remove the need to answer what REFLOW does on service failure —
    it means once that answer exists and REFLOW's bar is met, the same
    no-flag, no-dual-run approach applies to it too.
13. **UI engine-label rename** (`"z3"`/`"z3+lns"` wire values) — keep as
    legacy opaque tags or do a scoped rename; either is fine, needs a
    call before the status-vocabulary translation (`SolveBuildResponse`/
    `SolveRepairResponse` → `BuildStatus`) is implemented.

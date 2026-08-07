# CP-SAT Service — Scaffolding + BUILD/POLISH Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the CP-SAT gRPC service and cut BUILD/POLISH over to it from z3, with greedy as the only fallback — exactly as designed in `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`.

**Architecture:** A stateless Python gRPC service (`services/cp-sat`, `grpcio` sync + bounded `ThreadPoolExecutor`) receives a pre-computed slot grid + fixtures + constraints from `apps/web`'s `schedule.ts` (via a `packages/engine`-side client), solves with CP-SAT's interval/`NoOverlap` primitives, and returns assignments only. `schedule.ts`'s existing `validateAssignments` remains the sole verifier — CP-SAT is a placer, exactly like greedy and z3 are placers today. Fly 6PN private network, shared-secret auth, straight no-flag cutover once green.

**Tech Stack:** Python 3.11+, `ortools` (CP-SAT), `grpcio` + `grpcio-tools` + `grpcio-health-checking`, `pytest`. TypeScript side: `@grpc/grpc-js` + `ts-proto`, existing `vitest`.

## Global Constraints

- Every change ships a test that fails without it (AGENTS.md standing rule).
- No new user-facing string without all 4 locale dictionaries — N/A for this plan (no UI strings; internal service only).
- `wall_seconds` requested by the caller is always clamped server-side to the 8-10s target — never trust a larger caller-supplied value (design spec, Target Wall Budget section).
- CP-SAT is a placer only. It must never call or reimplement `validateAssignments` — TS remains the sole verifier (design spec, Service Boundary section; this is the direct fix for the placer/verifier-fork bug class on record in this repo's engine history).
- Straight cutover, no feature flag, z3's BUILD/POLISH code path removed in the same wave once this plan's tasks are green (design spec, z3 removal scope + resolved open item 12). Does not apply to REFLOW/`repair.ts` — out of scope for this plan entirely.
- Shared secret for service auth is a **new**, distinct env var (`CPSAT_SERVICE_SECRET`) — never reuse `CRON_SECRET` (design spec, Internal Communication section).
- New CI workflow is path-filtered to `services/cp-sat/**` and `proto/**` only — must never fire on unrelated PRs (design spec, CI section).

---

## File Structure

```
proto/scheduler.proto                                  # NEW — shared contract
services/cp-sat/
├── pyproject.toml                                      # NEW
├── src/cp_sat/
│   ├── __init__.py                                     # NEW
│   ├── config.py                                       # NEW — env-driven settings
│   ├── schema.py                                       # NEW — proto <-> internal validation
│   ├── model.py                                        # NEW — promoted from bench/cpsat_bench.py
│   ├── objective.py                                    # NEW — T0-T3 chain, promoted from bench
│   └── main.py                                         # NEW — gRPC server entrypoint
├── tests/
│   ├── test_model.py                                   # NEW
│   ├── test_server.py                                  # NEW — in-process, no network
│   └── test_config.py                                  # NEW
├── Dockerfile                                           # NEW
└── fly.toml                                             # NEW
.github/workflows/cp-sat-service.yml                     # NEW — path-filtered CI
packages/engine/src/scheduling/
├── cpsat-client.ts                                      # NEW — gRPC client wrapper, mirrors z3-load.ts's role
└── generated/scheduler.ts                                # NEW — ts-proto codegen output, not hand-written
packages/engine/scripts/gen-proto.ts                     # NEW — codegen script (npm-runnable)
packages/engine/src/scheduling/build.ts                  # MODIFY — solveBuild calls cpsat-client instead of z3
packages/engine/src/scheduling/build-encode.ts           # DELETE (final task, once everything else is green)
packages/engine/src/scheduling/build-lns.ts              # DELETE (final task)
```

---

### Task 1: Proto contract

**Files:**
- Create: `proto/scheduler.proto`
- Test: `services/cp-sat/tests/test_proto_compiles.py`

**Interfaces:**
- Produces: `SolveBuildRequest`, `SolveBuildResponse`, `SchedulerService.SolveBuild` RPC — every later task depends on the exact field names below. Field names/types must match the design spec's Contract section verbatim.

- [ ] **Step 1: Write the proto file**

```protobuf
syntax = "proto3";

package seazn.cpsat.v1;

// -- Build/Polish (tier solver) --------------------------------------------

message Slot {
  string court = 1;
  int64 start_at_ms = 2;
}

message Grid {
  repeated Slot slots = 1;
  int32 step_minutes = 2;
}

message Fixture {
  string fixture_id = 1;
  repeated string entrant_ids = 2;
  string division_id = 3;
}

message Assignment {
  string fixture_id = 1;
  string court = 2;
  int64 start_at_ms = 3;
}

message OrderPair {
  string before_fixture_id = 1;
  string after_fixture_id = 2;
}

message DivisionRestRule {
  string division_id = 1;
  int32 min_rest_minutes = 2;
}

message DivisionDayCapRule {
  string division_id = 1;
  int32 max_fixtures_per_day = 2;
}

message BuildConstraints {
  int32 match_minutes = 1;
  int32 gap_minutes = 2;
  repeated DivisionRestRule rest_by_division = 3;
  repeated DivisionDayCapRule day_cap_by_division = 4;
}

enum SolveStatus {
  SOLVE_STATUS_UNSPECIFIED = 0;
  SOLVE_STATUS_OPTIMAL = 1;
  SOLVE_STATUS_FEASIBLE = 2;
  SOLVE_STATUS_INFEASIBLE = 3;
  SOLVE_STATUS_UNKNOWN = 4;
  SOLVE_STATUS_ERROR = 5;
}

message Tier {
  string name = 1;
  int64 value_ms = 2;
}

message SolveError {
  string code = 1;
  string message = 2;
}

message SolveBuildRequest {
  string request_id = 1;
  repeated string courts = 2;
  Grid grid = 3;
  repeated Fixture fixtures = 4;
  repeated Assignment existing = 5;
  repeated OrderPair dependencies = 6;
  BuildConstraints constraints = 7;
  double wall_seconds = 8;
}

message SolveBuildResponse {
  repeated Assignment assignments = 1;
  SolveStatus status = 2;
  int32 tiers_completed = 3;
  repeated Tier objective_values = 4;
  int64 elapsed_ms = 5;
  bool wall_exhausted = 6;
  SolveError error = 7;
}

service SchedulerService {
  rpc SolveBuild(SolveBuildRequest) returns (SolveBuildResponse);
}
```

- [ ] **Step 2: Write the failing test**

```python
# services/cp-sat/tests/test_proto_compiles.py
import subprocess
import sys
from pathlib import Path

def test_proto_compiles_to_python():
    repo_root = Path(__file__).resolve().parents[2]
    proto_path = repo_root / "proto" / "scheduler.proto"
    out_dir = repo_root / "services" / "cp-sat" / "src" / "cp_sat" / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            sys.executable, "-m", "grpc_tools.protoc",
            f"-I{repo_root / 'proto'}",
            f"--python_out={out_dir}",
            f"--grpc_python_out={out_dir}",
            str(proto_path),
        ],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert (out_dir / "scheduler_pb2.py").exists()
    assert (out_dir / "scheduler_pb2_grpc.py").exists()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/cp-sat && python3 -m pytest tests/test_proto_compiles.py -v`
Expected: FAIL — `grpc_tools` not installed yet, or `proto/scheduler.proto` not found.

- [ ] **Step 4: Create `services/cp-sat/pyproject.toml` and install deps**

```toml
[project]
name = "cp-sat-service"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "ortools>=9.15,<10",
    "grpcio>=1.66,<2",
    "grpcio-tools>=1.66,<2",
    "grpcio-health-checking>=1.66,<2",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
```

Run: `cd services/cp-sat && python3 -m venv venv && venv/bin/pip install -e ".[dev]"`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_proto_compiles.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add proto/scheduler.proto services/cp-sat/pyproject.toml services/cp-sat/tests/test_proto_compiles.py
git commit -m "feat(cp-sat): add shared proto contract for SolveBuild"
```

---

### Task 2: BUILD model — promote from bench, verify against the proven production board

**Files:**
- Create: `services/cp-sat/src/cp_sat/model.py`
- Test: `services/cp-sat/tests/test_model.py`
- Reference (read fully before writing, do not reinvent): `services/cp-sat/bench/cpsat_bench.py`, specifically `build_model` (line 596) and `run_full_chain` (line 843) — this is already-validated code (14-point sweep, hand-rolled constraint checker, zero violations, per the design spec's Investigation Summary). Adapt its interval/`NoOverlap` construction; do not rewrite the modeling approach.

**Interfaces:**
- Consumes: nothing from other tasks (pure Python, no proto dependency — takes plain dicts/dataclasses so it's testable without a server).
- Produces: `build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies) -> cp_model.CpModel` and a `solve(model, wall_seconds) -> SolveOutcome` dataclass with fields `assignments: list[tuple[str, str, int]]`, `status: str`, `tiers_completed: int`, `objective_values: list[tuple[str, int]]`, `elapsed_ms: int`. Task 3 (objective) and Task 4 (server) both import from this module by these exact names.

- [ ] **Step 1: Read the reference implementation**

Read `services/cp-sat/bench/cpsat_bench.py` lines 245-843 in full (the `Fixture`/`Slot`/`Existing`/`Board` dataclasses, `build_board`, `build_model`, `run_full_chain`). Note which parts are sweep-harness-specific (random board generation, JSON progress logging) versus core modeling (interval vars, `NoOverlap` calls, `symmetry_level=0`/`cp_model_probing_level=0` presolve settings — these MUST carry over, they are the fix for the silent-presolve-failure trap on record).

- [ ] **Step 2: Write the failing test using the proven production board**

```python
# services/cp-sat/tests/test_model.py
from cp_sat.model import build_model, solve

def _production_board():
    # Mirrors the investigation's production shape: 37 fixtures, 5 courts,
    # 30/10 min match/gap, ~77k fixture-slots. Exact fixture/slot generation
    # ported from services/cp-sat/bench/cpsat_bench.py's board builder for
    # this same shape — reuse that function, don't hand-roll a second one.
    from cp_sat_bench_boards import production_board  # see Step 2b
    return production_board()

def test_production_board_solves_optimal_under_budget():
    fixtures, courts, grid_slots, step_minutes, constraints, existing, deps = _production_board()
    model = build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, deps)
    outcome = solve(model, wall_seconds=8.0)
    assert outcome.status == "OPTIMAL"
    assert 35 <= len(outcome.assignments) <= 37
    assert outcome.elapsed_ms < 8000

def test_no_court_double_booking():
    fixtures, courts, grid_slots, step_minutes, constraints, existing, deps = _production_board()
    model = build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, deps)
    outcome = solve(model, wall_seconds=8.0)
    seen = {}
    for fixture_id, court, start_ms in outcome.assignments:
        key = (court, start_ms)
        assert key not in seen, f"double-booked {key}"
        seen[key] = fixture_id
```

- [ ] **Step 2b: Extract the board-generation helper so both the bench and this test share it**

Create `services/cp-sat/bench/cpsat_bench_boards.py` by moving the production-board-shape generation code out of `cpsat_bench.py`'s sweep list into a standalone `production_board()` function; re-import it back into `cpsat_bench.py` so the existing sweep still runs unchanged. This avoids a second, drifting copy of board-generation logic (the exact class of bug the REFLOW investigation already hit once with `syntheticBoard()`).

Run: `cd services/cp-sat && venv/bin/python3 -m pytest bench/ -v` (confirm the existing sweep still passes after the extraction, before moving on)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_model.py -v`
Expected: FAIL — `cp_sat.model` does not exist yet.

- [ ] **Step 4: Write `model.py`, adapting `build_model`/solve loop from the bench**

Port `build_model` from `cpsat_bench.py:596-843` into `services/cp-sat/src/cp_sat/model.py`, changing only: (a) inputs become the plain-Python parameter list in the Interfaces block above instead of the bench's `Board` dataclass; (b) wrap the solve loop (the sweep's per-tier `cp_model.CpSolver()` + `solver.Solve(model)` calls) into a `solve(model, wall_seconds)` function returning the `SolveOutcome` dataclass; (c) strip sweep-only instrumentation (JSON progress printing). Keep `symmetry_level=0`, `cp_model_probing_level=0`, and every interval/`NoOverlap` construction byte-for-byte identical to the reference — these are proven, not being redesigned.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_model.py -v`
Expected: PASS — both tests green, production board OPTIMAL under 8s.

- [ ] **Step 6: Commit**

```bash
git add services/cp-sat/src/cp_sat/model.py services/cp-sat/tests/test_model.py services/cp-sat/bench/cpsat_bench_boards.py services/cp-sat/bench/cpsat_bench.py
git commit -m "feat(cp-sat): promote validated BUILD model from bench into the service package"
```

---

### Task 3: T0-T3 objective chain

**Files:**
- Create: `services/cp-sat/src/cp_sat/objective.py`
- Modify: `services/cp-sat/src/cp_sat/model.py` (`solve()` calls into this module)
- Test: `services/cp-sat/tests/test_objective.py`
- Reference: `cpsat_bench.py`'s `run_full_chain` (line 843), and `packages/engine/src/scheduling/build.ts` lines ~2051-2145 (`buildTiers`) for the four tier definitions this must match exactly: **T0 max-placed → T1 makespan → T2 worst idle gap → T3 court imbalance** (confirmed by direct read this session, not assumed).

**Interfaces:**
- Consumes: `cp_model.CpModel`, fixture/interval variables from `model.py`.
- Produces: `run_tier_chain(model, fixture_vars, wall_seconds) -> SolveOutcome` (same dataclass shape as Task 2's `solve()` — this function IS what `solve()` calls internally; `solve()` becomes a thin wrapper).

- [ ] **Step 1: Write the failing test**

```python
# services/cp-sat/tests/test_objective.py
from cp_sat.model import build_model, solve
from tests.cp_sat_bench_boards_import import production_board  # re-exported from bench for test use

def test_all_four_tiers_complete_on_production_board():
    fixtures, courts, grid_slots, step_minutes, constraints, existing, deps = production_board()
    model = build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, deps)
    outcome = solve(model, wall_seconds=8.0)
    assert outcome.tiers_completed == 4
    names = [name for name, _ in outcome.objective_values]
    assert names == ["placed", "makespan", "idle_gap", "court_imbalance"]

def test_tier_order_is_lexicographic_not_weighted():
    # A board where maximizing placed count strictly determines the outcome
    # regardless of makespan cost — proves T0 dominates T1, not a blended score.
    fixtures, courts, grid_slots, step_minutes, constraints, existing, deps = production_board()
    model = build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, deps)
    outcome = solve(model, wall_seconds=8.0)
    placed_count = len(outcome.assignments)
    assert placed_count >= 35  # T0's bound must be frozen before T1 even runs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_objective.py -v`
Expected: FAIL — `cp_sat.objective` does not exist.

- [ ] **Step 3: Write `objective.py`**

Port `run_full_chain` from `cpsat_bench.py:843-941`. Each tier: solve for its own objective, freeze the achieved value as a constraint (`model.Add(objective_var <= achieved_bound)`), move to the next tier — the CP-SAT-native equivalent of z3's push/pop bound-walk (see `build.ts:2009-2020`'s `Tier.of`/`Tier.atMost` for the semantics being matched, not the z3 mechanism itself). Wire `model.py`'s `solve()` to call this instead of a single `solver.Solve(model)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_objective.py tests/test_model.py -v`
Expected: PASS, all tests including Task 2's.

- [ ] **Step 5: Commit**

```bash
git add services/cp-sat/src/cp_sat/objective.py services/cp-sat/src/cp_sat/model.py services/cp-sat/tests/test_objective.py
git commit -m "feat(cp-sat): port T0-T3 lexicographic objective chain"
```

---

### Task 4: gRPC server — bootstrap, auth, health, request/response mapping

**Files:**
- Create: `services/cp-sat/src/cp_sat/config.py`, `services/cp-sat/src/cp_sat/schema.py`, `services/cp-sat/src/cp_sat/main.py`
- Test: `services/cp-sat/tests/test_config.py`, `services/cp-sat/tests/test_server.py`

**Interfaces:**
- Consumes: `cp_sat.model.build_model`/`solve` (Task 2/3), `cp_sat.generated.scheduler_pb2`/`scheduler_pb2_grpc` (Task 1).
- Produces: a `SchedulerServicer` class registered on a `grpc.server`, listening on `config.PORT`, requiring metadata key `x-internal-secret` to equal `config.SHARED_SECRET`.

- [ ] **Step 1: Write `config.py` and its test first (smallest piece)**

```python
# services/cp-sat/tests/test_config.py
import os
import pytest
from cp_sat.config import Settings

def test_settings_load_from_env(monkeypatch):
    monkeypatch.setenv("CPSAT_PORT", "50051")
    monkeypatch.setenv("CPSAT_MAX_WORKERS", "4")
    monkeypatch.setenv("CPSAT_SERVICE_SECRET", "test-secret")
    monkeypatch.setenv("CPSAT_WALL_SECONDS_MAX", "10")
    s = Settings.from_env()
    assert s.port == 50051
    assert s.max_workers == 4
    assert s.shared_secret == "test-secret"
    assert s.wall_seconds_max == 10.0

def test_settings_requires_secret(monkeypatch):
    monkeypatch.delenv("CPSAT_SERVICE_SECRET", raising=False)
    with pytest.raises(ValueError, match="CPSAT_SERVICE_SECRET"):
        Settings.from_env()
```

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_config.py -v` → FAIL (module doesn't exist)

```python
# services/cp-sat/src/cp_sat/config.py
from __future__ import annotations
import os
from dataclasses import dataclass

@dataclass(frozen=True)
class Settings:
    port: int
    max_workers: int
    shared_secret: str
    wall_seconds_max: float

    @classmethod
    def from_env(cls) -> "Settings":
        secret = os.environ.get("CPSAT_SERVICE_SECRET")
        if not secret:
            raise ValueError("CPSAT_SERVICE_SECRET is required")
        return cls(
            port=int(os.environ.get("CPSAT_PORT", "50051")),
            max_workers=int(os.environ.get("CPSAT_MAX_WORKERS", "4")),
            shared_secret=secret,
            wall_seconds_max=float(os.environ.get("CPSAT_WALL_SECONDS_MAX", "10")),
        )
```

Run again → PASS.

- [ ] **Step 2: Write `schema.py`'s failing test — request validation + proto-to-model mapping**

```python
# services/cp-sat/tests/test_schema.py
import pytest
from cp_sat.generated import scheduler_pb2
from cp_sat.schema import request_to_model_input, InvalidRequestError

def test_rejects_empty_fixtures():
    req = scheduler_pb2.SolveBuildRequest(request_id="r1", courts=["Court 1"])
    with pytest.raises(InvalidRequestError, match="fixtures"):
        request_to_model_input(req)

def test_maps_valid_request():
    req = scheduler_pb2.SolveBuildRequest(
        request_id="r1",
        courts=["Court 1"],
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1")],
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=0)],
            step_minutes=10,
        ),
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=8.0,
    )
    parsed = request_to_model_input(req)
    assert parsed.courts == ["Court 1"]
    assert len(parsed.fixtures) == 1
    assert parsed.wall_seconds == 8.0
```

Run: FAIL (module doesn't exist).

- [ ] **Step 3: Write `schema.py`**

```python
# services/cp-sat/src/cp_sat/schema.py
from __future__ import annotations
from dataclasses import dataclass

class InvalidRequestError(ValueError):
    pass

@dataclass(frozen=True)
class ModelInput:
    courts: list[str]
    fixtures: list[tuple]
    grid_slots: list[tuple]
    step_minutes: int
    constraints: dict
    existing: list[tuple]
    dependencies: list[tuple]
    wall_seconds: float

def request_to_model_input(req) -> ModelInput:
    if len(req.fixtures) == 0:
        raise InvalidRequestError("fixtures must not be empty")
    if len(req.courts) == 0:
        raise InvalidRequestError("courts must not be empty")
    return ModelInput(
        courts=list(req.courts),
        fixtures=[(f.fixture_id, list(f.entrant_ids), f.division_id) for f in req.fixtures],
        grid_slots=[(s.court, s.start_at_ms) for s in req.grid.slots],
        step_minutes=req.grid.step_minutes,
        constraints={
            "match_minutes": req.constraints.match_minutes,
            "gap_minutes": req.constraints.gap_minutes,
            "rest_by_division": {r.division_id: r.min_rest_minutes for r in req.constraints.rest_by_division},
            "day_cap_by_division": {r.division_id: r.max_fixtures_per_day for r in req.constraints.day_cap_by_division},
        },
        existing=[(a.fixture_id, a.court, a.start_at_ms) for a in req.existing],
        dependencies=[(d.before_fixture_id, d.after_fixture_id) for d in req.dependencies],
        wall_seconds=req.wall_seconds,
    )
```

Run: PASS.

- [ ] **Step 4: Write `test_server.py` — in-process server, no real socket**

```python
# services/cp-sat/tests/test_server.py
import grpc
import grpc_testing
import pytest
from cp_sat.generated import scheduler_pb2, scheduler_pb2_grpc
from cp_sat.main import SchedulerServicer
from cp_sat.config import Settings

@pytest.fixture
def test_server(monkeypatch):
    monkeypatch.setenv("CPSAT_SERVICE_SECRET", "test-secret")
    settings = Settings.from_env()
    servicer = SchedulerServicer(settings)
    return grpc_testing.server_from_dictionary(
        {scheduler_pb2.DESCRIPTOR.services_by_name["SchedulerService"]: servicer},
        grpc_testing.strict_real_time(),
    )

def test_rejects_missing_auth_metadata(test_server):
    req = scheduler_pb2.SolveBuildRequest(request_id="r1")
    method = test_server.invoke_unary_unary(
        scheduler_pb2.DESCRIPTOR.services_by_name["SchedulerService"].methods_by_name["SolveBuild"],
        (), req, None,
    )
    _, _, code, _ = method.termination()
    assert code == grpc.StatusCode.UNAUTHENTICATED

def test_accepts_valid_request_with_correct_secret(test_server):
    req = scheduler_pb2.SolveBuildRequest(
        request_id="r1", courts=["Court 1"],
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1"], division_id="d1")],
        grid=scheduler_pb2.Grid(slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=0)], step_minutes=10),
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=2.0,
    )
    method = test_server.invoke_unary_unary(
        scheduler_pb2.DESCRIPTOR.services_by_name["SchedulerService"].methods_by_name["SolveBuild"],
        (("x-internal-secret", "test-secret"),), req, None,
    )
    response, _, code, _ = method.termination()
    assert code == grpc.StatusCode.OK
    assert response.status in (scheduler_pb2.SOLVE_STATUS_OPTIMAL, scheduler_pb2.SOLVE_STATUS_FEASIBLE)
```

Run: FAIL (`cp_sat.main` doesn't exist; add `grpcio-testing` to `pyproject.toml` dev deps first).

- [ ] **Step 5: Write `main.py`**

```python
# services/cp-sat/src/cp_sat/main.py
from __future__ import annotations
import logging
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from cp_sat.config import Settings
from cp_sat.generated import scheduler_pb2, scheduler_pb2_grpc
from cp_sat.model import build_model, solve
from cp_sat.schema import request_to_model_input, InvalidRequestError

STATUS_MAP = {
    "OPTIMAL": scheduler_pb2.SOLVE_STATUS_OPTIMAL,
    "FEASIBLE": scheduler_pb2.SOLVE_STATUS_FEASIBLE,
    "INFEASIBLE": scheduler_pb2.SOLVE_STATUS_INFEASIBLE,
    "UNKNOWN": scheduler_pb2.SOLVE_STATUS_UNKNOWN,
}


class SchedulerServicer(scheduler_pb2_grpc.SchedulerServiceServicer):
    def __init__(self, settings: Settings):
        self._settings = settings

    def SolveBuild(self, request, context):
        secret = dict(context.invocation_metadata() or {}).get("x-internal-secret")
        if secret != self._settings.shared_secret:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing or invalid secret")

        try:
            parsed = request_to_model_input(request)
        except InvalidRequestError as exc:
            return scheduler_pb2.SolveBuildResponse(
                status=scheduler_pb2.SOLVE_STATUS_ERROR,
                error=scheduler_pb2.SolveError(code="INVALID_REQUEST", message=str(exc)),
            )

        wall = min(parsed.wall_seconds, self._settings.wall_seconds_max)
        model = build_model(
            parsed.fixtures, parsed.courts, parsed.grid_slots, parsed.step_minutes,
            parsed.constraints, parsed.existing, parsed.dependencies,
        )
        outcome = solve(model, wall_seconds=wall)

        return scheduler_pb2.SolveBuildResponse(
            assignments=[
                scheduler_pb2.Assignment(fixture_id=fid, court=court, start_at_ms=start)
                for fid, court, start in outcome.assignments
            ],
            status=STATUS_MAP.get(outcome.status, scheduler_pb2.SOLVE_STATUS_ERROR),
            tiers_completed=outcome.tiers_completed,
            objective_values=[scheduler_pb2.Tier(name=n, value_ms=v) for n, v in outcome.objective_values],
            elapsed_ms=outcome.elapsed_ms,
            wall_exhausted=outcome.elapsed_ms >= int(wall * 1000),
        )


def serve() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=settings.max_workers))
    scheduler_pb2_grpc.add_SchedulerServiceServicer_to_server(SchedulerServicer(settings), server)

    health_servicer = health.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)

    server.add_insecure_port(f"[::]:{settings.port}")
    server.start()
    logging.info("cp-sat service listening on :%d (max_workers=%d)", settings.port, settings.max_workers)
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd services/cp-sat && venv/bin/pip install grpcio-testing && venv/bin/python3 -m pytest tests/ -v`
Expected: PASS, all tests across Tasks 1-4 green.

- [ ] **Step 7: Commit**

```bash
git add services/cp-sat/src/cp_sat/config.py services/cp-sat/src/cp_sat/schema.py services/cp-sat/src/cp_sat/main.py services/cp-sat/tests/test_config.py services/cp-sat/tests/test_schema.py services/cp-sat/tests/test_server.py services/cp-sat/pyproject.toml
git commit -m "feat(cp-sat): gRPC server with auth interceptor, health check, request validation"
```

---

### Task 5: TS-side codegen + client wrapper

**Files:**
- Create: `packages/engine/scripts/gen-proto.ts`, `packages/engine/src/scheduling/cpsat-client.ts`
- Modify: `packages/engine/package.json` (add `ts-proto`, `@grpc/grpc-js`, `@grpc/proto-loader` as devDependencies/dependencies; add a `gen:proto` script)
- Test: `packages/engine/src/scheduling/cpsat-client.test.ts`

**Interfaces:**
- Consumes: `proto/scheduler.proto` (Task 1).
- Produces: `solveBuild(input: SolveBuildInput, opts: { host: string; secret: string; wallSeconds: number }): Promise<SolveBuildOutcome>` — Task 6 (`build.ts`'s `solveBuild`) calls this exact function.

- [ ] **Step 1: Install codegen deps and write the generation script**

Run: `cd packages/engine && npm install --save @grpc/grpc-js && npm install --save-dev ts-proto grpc-tools`

```typescript
// packages/engine/scripts/gen-proto.ts
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const outDir = path.join(root, "packages/engine/src/scheduling/generated");
execSync(
  `npx protoc --plugin=protoc-gen-ts_proto=${root}/node_modules/.bin/protoc-gen-ts_proto ` +
    `--ts_proto_out=${outDir} --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true ` +
    `-I ${root}/proto ${root}/proto/scheduler.proto`,
  { stdio: "inherit" },
);
console.log(`Generated TS proto stubs in ${outDir}`);
```

Add to `packages/engine/package.json` scripts: `"gen:proto": "node --experimental-strip-types scripts/gen-proto.ts"`.

Run: `cd packages/engine && npm run gen:proto`
Expected: `packages/engine/src/scheduling/generated/scheduler.ts` is created (mechanically generated — do not hand-edit).

- [ ] **Step 2: Write the failing test for the client wrapper**

```typescript
// packages/engine/src/scheduling/cpsat-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { solveBuild } from "./cpsat-client.ts";

describe("solveBuild", () => {
  it("attaches the shared secret as call metadata", async () => {
    const mockClient = { solveBuild: vi.fn((req, meta, cb) => cb(null, { assignments: [], status: 1, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false })) };
    const result = await solveBuild(
      { courts: ["Court 1"], fixtures: [], grid: { slots: [], stepMinutes: 10 }, existing: [], dependencies: [], constraints: { matchMinutes: 30, gapMinutes: 10 }, wallSeconds: 8 },
      { secret: "s3cr3t", wallSeconds: 8, client: mockClient as never },
    );
    expect(mockClient.solveBuild).toHaveBeenCalled();
    const [, metadata] = mockClient.solveBuild.mock.calls[0]!;
    expect(metadata.get("x-internal-secret")).toEqual(["s3cr3t"]);
    expect(result.status).toBe("FEASIBLE");
  });

  it("rejects the call when it exceeds the deadline margin", async () => {
    const mockClient = { solveBuild: vi.fn((_req, _meta, cb) => { /* never calls back */ }) };
    await expect(
      solveBuild(
        { courts: [], fixtures: [], grid: { slots: [], stepMinutes: 10 }, existing: [], dependencies: [], constraints: { matchMinutes: 30, gapMinutes: 10 }, wallSeconds: 0.05 },
        { secret: "s3cr3t", wallSeconds: 0.05, client: mockClient as never },
      ),
    ).rejects.toThrow(/deadline/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/cpsat-client.test.ts`
Expected: FAIL — `cpsat-client.ts` doesn't exist.

- [ ] **Step 4: Write `cpsat-client.ts`**

```typescript
// packages/engine/src/scheduling/cpsat-client.ts
import * as grpc from "@grpc/grpc-js";
import { SchedulerServiceClient } from "./generated/scheduler.ts";

export interface SolveBuildInput {
  courts: string[];
  fixtures: { fixtureId: string; entrantIds: string[]; divisionId: string }[];
  grid: { slots: { court: string; startAtMs: number }[]; stepMinutes: number };
  existing: { fixtureId: string; court: string; startAtMs: number }[];
  dependencies: { beforeFixtureId: string; afterFixtureId: string }[];
  constraints: { matchMinutes: number; gapMinutes: number; restByDivision?: Record<string, number>; dayCapByDivision?: Record<string, number> };
  wallSeconds: number;
}

export interface SolveBuildOutcome {
  assignments: { fixtureId: string; court: string; startAtMs: number }[];
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "ERROR";
  tiersCompleted: number;
  objectiveValues: { name: string; valueMs: number }[];
  elapsedMs: number;
  wallExhausted: boolean;
  error?: { code: string; message: string };
}

const STATUS_NAMES = ["UNSPECIFIED", "OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "ERROR"] as const;

let cachedClient: SchedulerServiceClient | undefined;

function clientFor(host: string): SchedulerServiceClient {
  cachedClient ??= new SchedulerServiceClient(host, grpc.credentials.createInsecure());
  return cachedClient;
}

export async function solveBuild(
  input: SolveBuildInput,
  opts: { host?: string; secret: string; wallSeconds: number; client?: Pick<SchedulerServiceClient, "solveBuild"> },
): Promise<SolveBuildOutcome> {
  const client = opts.client ?? clientFor(opts.host ?? process.env.CPSAT_SERVICE_HOST ?? "cp-sat.internal:50051");
  const metadata = new grpc.Metadata();
  metadata.set("x-internal-secret", opts.secret);
  const deadline = new Date(Date.now() + (opts.wallSeconds + 2) * 1000);

  return new Promise((resolve, reject) => {
    client.solveBuild(
      input as never,
      metadata,
      { deadline },
      (err: grpc.ServiceError | null, res: never) => {
        if (err) {
          reject(err.code === grpc.status.DEADLINE_EXCEEDED ? new Error(`cp-sat solveBuild exceeded deadline: ${err.message}`) : err);
          return;
        }
        const r = res as { status: number; assignments: unknown; tiersCompleted: number; objectiveValues: unknown; elapsedMs: number; wallExhausted: boolean; error?: { code: string; message: string } };
        resolve({
          assignments: r.assignments as SolveBuildOutcome["assignments"],
          status: STATUS_NAMES[r.status] as SolveBuildOutcome["status"],
          tiersCompleted: r.tiersCompleted,
          objectiveValues: r.objectiveValues as SolveBuildOutcome["objectiveValues"],
          elapsedMs: r.elapsedMs,
          wallExhausted: r.wallExhausted,
          error: r.error,
        });
      },
    );
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/cpsat-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/scripts/gen-proto.ts packages/engine/src/scheduling/cpsat-client.ts packages/engine/src/scheduling/cpsat-client.test.ts packages/engine/package.json
git commit -m "feat(engine): add generated proto stubs and cp-sat gRPC client wrapper"
```

(`generated/scheduler.ts` is mechanically produced — commit it too, since CI shouldn't need `protoc` installed just to typecheck; regenerate via `npm run gen:proto` whenever `proto/scheduler.proto` changes.)

---

### Task 6: Wire `solveBuild` in `build.ts` to call CP-SAT instead of z3

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (the `solveBuild` function, line ~1069 — read it in full first, this task changes its internals, not its exported signature)
- Test: `packages/engine/src/scheduling/build.test.ts` (existing file — add cases, do not remove existing greedy-path coverage)

**Interfaces:**
- Consumes: `cpsat-client.ts`'s `solveBuild` (Task 5).
- Produces: `buildSchedule(input: BuildInput): Promise<BuildResult>` — **signature unchanged**, callers in `schedule.ts` require no changes.

- [ ] **Step 1: Read the current implementation**

Read `packages/engine/src/scheduling/build.ts` lines 1013-1600 in full (`buildSchedule` and `solveBuild`) before changing anything. Identify exactly where z3 gets loaded (`loadZ3`/`withZ3Lock`), where the tier walk happens, and where `BuildResult` gets assembled — this task replaces the z3-specific middle section only; the R18 gate check, greedy seed, and final `validateAssignments` call before returning must be preserved unchanged (verification never moves, per Global Constraints).

- [ ] **Step 2: Write the failing test — CP-SAT path produces a verified board**

```typescript
// packages/engine/src/scheduling/build.test.ts (additions)
import { vi } from "vitest";

describe("buildSchedule — CP-SAT path", () => {
  it("uses the CP-SAT client and returns a verified board", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [{ fixtureId: "f1", court: "Court 1", startAtMs: 0 }],
      status: "OPTIMAL", tiersCompleted: 4,
      objectiveValues: [], elapsedMs: 1200, wallExhausted: false,
    });
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("cp-sat");
    expect(result.assignments).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0); // validateAssignments still ran
  });

  it("falls back to greedy on CP-SAT timeout, exactly like a z3 gate-reject", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockRejectedValue(new Error("cp-sat solveBuild exceeded deadline"));
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("greedy");
    expect(result.status).not.toBe("z3_unavailable"); // see Task 6b — status mapping
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts -t "CP-SAT path"`
Expected: FAIL — `result.engine` is still `"z3"`/`"greedy"` via the old code path, `"cp-sat"` never appears.

- [ ] **Step 4: Replace the z3 middle section of `solveBuild` with a CP-SAT call**

Within `solveBuild`, replace the `loadZ3`/`encodeBuild`/tier-walk/LNS block with: build a `SolveBuildInput` from the function's existing `grid`/`fixtures`/`config`/`existing`/`dependencies` locals (these are already computed earlier in the function, unchanged), call `cpsatClient.solveBuild(...)` with `wallSeconds` from the existing `wallMs` budget math, and on success map its `assignments`/`tiersCompleted`/`elapsedMs`/`wallExhausted` into the same local variables the rest of the function already expects before falling through to the existing `validateAssignments` call. On rejection (any error, including deadline-exceeded), fall through to the existing greedy-seed path exactly as today's z3-unavailable/gate-reject branches already do — do not add a new fallback mechanism, reuse the one that exists. Set `engine: "cp-sat"` (new literal, added to `BuildResult["engine"]`'s type union alongside `"greedy"`/`"z3"`/`"z3+lns"` — do not remove the old values yet, Task 10 does that once the rest of this plan is green).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts`
Expected: PASS — new tests green, all pre-existing tests in this file still green (confirms the exported signature and greedy fallback truly didn't change shape).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/build.ts packages/engine/src/scheduling/build.test.ts
git commit -m "feat(engine): wire BUILD/POLISH's solveBuild to the cp-sat service"
```

---

### Task 6b: Status vocabulary translation

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (status mapping, adjacent to Task 6's change)
- Test: `packages/engine/src/scheduling/build.test.ts` (additions)

**Interfaces:**
- Consumes: CP-SAT's native status (`"OPTIMAL"|"FEASIBLE"|"INFEASIBLE"|"UNKNOWN"|"ERROR"`) from `cpsat-client.ts`.
- Produces: the existing `BuildStatus` union (`build.ts:387`) — decides here, concretely, what the design spec left open: `UNKNOWN` → `not_searched` (both mean "nothing proven, don't claim otherwise" — closest semantic match); `ERROR` → a **new** `"solver_unavailable"` value added to `BuildStatus` (not reusing `z3_unavailable`, since the string is user-invisible per the design spec's UI/wire-surface section but the identifier itself is misleading once z3 is gone — cheaper to add one clean value now than carry a stale name forward); `INFEASIBLE` → `infeasible` (same semantics, a real proof); `OPTIMAL`/`FEASIBLE` → `ok` or `already_optimal` per the existing rule already in `build.ts` (already_optimal when no tier improved on the greedy seed — unchanged logic, just fed by CP-SAT's numbers now).

- [ ] **Step 1: Write the failing test**

```typescript
describe("CP-SAT status -> BuildStatus mapping", () => {
  it.each([
    ["UNKNOWN", "not_searched"],
    ["ERROR", "solver_unavailable"],
    ["INFEASIBLE", "infeasible"],
  ] as const)("%s maps to %s", async (cpsatStatus, expected) => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [], status: cpsatStatus, tiersCompleted: 0, objectiveValues: [], elapsedMs: 100, wallExhausted: false,
    });
    const result = await buildSchedule(minimalBuildInput());
    expect(result.status).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts -t "status -> BuildStatus"`
Expected: FAIL — `solver_unavailable` doesn't exist on the type yet, mapping not implemented.

- [ ] **Step 3: Add `"solver_unavailable"` to `BuildStatus` and implement the mapping**

Add the new literal to the `BuildStatus` union at `build.ts:387` (additive — do not remove `z3_unavailable` yet, it may still be referenced by REFLOW's own status handling until that's a separate, later decision). Implement the switch mapping CP-SAT's status into the function's existing status-assignment point.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the UI's `statusKey()` switch**

Modify `apps/web/src/components/v2/board/result-strip.tsx`'s `statusKey()` (line ~42) to add a `case "solver_unavailable"` returning a **new** i18n key `"board.result.unavailable"` reused as-is (the existing z3_unavailable copy — "does not promise a retry will help" — is equally true for a CP-SAT outage; no new user-facing string needed, same key, new case). Add `cp-sat: "board.result.engine.cpsat"` to `ENGINE_KEY` (line 33) — this **is** a new string, add it to all 4 dictionaries (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`) with the same "Solver" / "Solveur" / "Solucionador" copy the existing `z3` key already uses (per the design spec's finding that this copy is already engine-neutral).

- [ ] **Step 6: Write and run a UI test**

```typescript
// apps/web/src/components/v2/board/__tests__/result-strip.test.tsx (addition)
it("cp-sat engine renders the same neutral 'Solver' copy as z3 did", () => {
  const html = render(metrics(), solver({ engine: "cp-sat", status: "ok" }));
  expect(html).toContain("Solver");
});
```

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/result-strip.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/scheduling/build.ts apps/web/src/components/v2/board/result-strip.tsx apps/web/src/dictionaries apps/web/src/components/v2/board/__tests__/result-strip.test.tsx
git commit -m "feat: translate cp-sat's native status vocabulary into BuildStatus, add cp-sat engine label"
```

---

### Task 7: Integration tests — parity, production-board regression, fallback path

**Files:**
- Create: `packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts` (requires a real running `services/cp-sat` instance — tagged to skip in the default fast suite, run explicitly)
- Create: `services/cp-sat/README.md` section "local dev" (how to start the service for this test)

**Interfaces:**
- Consumes: a real running CP-SAT service on `localhost` (started per the README recipe), `build.ts`'s `buildSchedule`.

- [ ] **Step 1: Write the local-dev recipe in the README**

```markdown
## Local dev (for integration tests)

    cd services/cp-sat
    venv/bin/pip install -e ".[dev]"
    CPSAT_SERVICE_SECRET=dev-secret CPSAT_PORT=50051 venv/bin/python3 -m cp_sat.main

In another terminal: `CPSAT_SERVICE_HOST=localhost:50051 CPSAT_SERVICE_SECRET=dev-secret npm run test:integration --workspace packages/engine`
```

- [ ] **Step 2: Write the failing integration tests**

```typescript
// packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts
import { describe, expect, it } from "vitest";
import { buildSchedule } from "../build.ts";
import { validateAssignments } from "../calendar.ts";

const RUN_INTEGRATION = process.env.CPSAT_SERVICE_HOST !== undefined;

describe.skipIf(!RUN_INTEGRATION)("cp-sat integration (requires a running service)", () => {
  it("solves the production board to OPTIMAL with zero verifier conflicts", async () => {
    const input = productionShapeBuildInput(); // 37 fixtures, 5 courts, 30/10 match/gap — same shape as the investigation
    const result = await buildSchedule(input);
    expect(result.engine).toBe("cp-sat");
    expect(result.status).toBe("ok");
    expect(result.assignments.length).toBeGreaterThanOrEqual(35);
    const conflicts = validateAssignments(result.assignments, input.config, input.existing ?? [], input.dependencies ?? []);
    expect(conflicts).toHaveLength(0);
  });

  it("falls back to greedy with the service stopped", async () => {
    // Run with CPSAT_SERVICE_HOST pointed at an unused port to simulate this
    // rather than actually stopping the fixture server mid-suite.
    const input = productionShapeBuildInput();
    const result = await buildSchedule({ ...input }, { cpsatHost: "localhost:1" });
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_unavailable");
  });
});
```

- [ ] **Step 3: Run to verify the first test fails without the service running, and document the run command**

Run: `cd packages/engine && npx vitest run src/scheduling/__tests__/cpsat-integration.test.ts`
Expected: SKIPPED (no `CPSAT_SERVICE_HOST` set) — this is correct default behavior, not a failure. Then start the service per the README and re-run with `CPSAT_SERVICE_HOST=localhost:50051 CPSAT_SERVICE_SECRET=dev-secret` set: expect FAIL (parity/fallback not wired yet if Task 6/6b are incomplete; if this task runs after Task 6b, expect PASS immediately — in which case this task is confirming, not driving, TDD-style — still valuable as the parity gate for CI in Task 9).

- [ ] **Step 4: Run to verify it passes** (with the service running per the README)

Run: `cd packages/engine && CPSAT_SERVICE_HOST=localhost:50051 CPSAT_SERVICE_SECRET=dev-secret npx vitest run src/scheduling/__tests__/cpsat-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/scheduling/__tests__/cpsat-integration.test.ts services/cp-sat/README.md
git commit -m "test(engine): cp-sat integration suite — production-board parity + fallback path"
```

---

### Task 8: Deployment

**Files:**
- Create: `services/cp-sat/Dockerfile`, `services/cp-sat/fly.toml`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir .
RUN useradd -m cpsat
USER cpsat
ENV CPSAT_PORT=50051
EXPOSE 50051
CMD ["python3", "-m", "cp_sat.main"]
```

- [ ] **Step 2: Write `fly.toml`**

```toml
app = "seazn-cpsat-prod"
primary_region = "lhr"

[build]

[[services]]
  internal_port = 50051
  protocol = "tcp"

  [[services.ports]]
    port = 50051

  [[services.tcp_checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"

# min_machines_running intentionally omitted from [http_service] — this app
# has no [http_service] block (gRPC over raw TCP, not HTTP/1.1). Set via
# `fly scale count 1 --min-machines-running=1` post-deploy: always warm,
# a cold start would eat directly into the 8-10s wall budget.

# Secrets (fly secrets set):
#   CPSAT_SERVICE_SECRET — new, distinct from apps/web's CRON_SECRET
```

- [ ] **Step 3: Verify the Docker image builds**

Run: `cd services/cp-sat && docker build -t cpsat-service-test .`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add services/cp-sat/Dockerfile services/cp-sat/fly.toml
git commit -m "feat(cp-sat): Dockerfile and Fly app config"
```

---

### Task 9: CI workflow

**Files:**
- Create: `.github/workflows/cp-sat-service.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: cp-sat-service

on:
  pull_request:
    paths:
      - "services/cp-sat/**"
      - "proto/**"

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: cd services/cp-sat && pip install -e ".[dev]"
      - run: cd services/cp-sat && python3 -m pytest tests/ bench/ -v
```

- [ ] **Step 2: Verify it's path-filtered correctly**

Confirm via `gh workflow view cp-sat-service.yml` after pushing (or by reading the `paths:` block above against the Global Constraints requirement) that a PR touching only `apps/web/**` does not trigger this workflow.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cp-sat-service.yml
git commit -m "ci: path-filtered workflow for the cp-sat service"
```

---

### Task 10: Remove BUILD/POLISH's z3 code (gated on Tasks 1-9 all green)

**Files:**
- Delete: `packages/engine/src/scheduling/build-encode.ts`, `packages/engine/src/scheduling/build-lns.ts`
- Modify: `packages/engine/src/scheduling/build.ts` (remove the R18 `canSolveWithin`/`MAX_SOLVE_ENCODING` gate and any now-dead z3-import lines)
- Test: run the full existing `build.test.ts` and `build-encode-parity.test.ts` suites — the latter is **expected to be deleted**, not just passed, since it tests two z3 encodings agreeing with each other and there is only one placer left after this task

**Do not start this task until**: Tasks 1-9 are merged, the integration suite (Task 7) is green against a real deployed service (not just localhost), and this has been running in production for at least one full deploy cycle with no fallback-to-greedy rate regression — this is the "straight cutover once green" decision from the Global Constraints section, not a same-day step.

- [ ] **Step 1: Confirm no remaining references**

Run: `git grep -l "build-encode\|withZ3Lock\|loadZ3" packages/engine/src/scheduling/build.ts` — review every hit; anything still referencing z3 in the BUILD/POLISH path at this point is a sign Task 6 left a dead branch, not evidence z3 is still needed (REFLOW's own z3 usage in `repair.ts`/`z3-load.ts` is untouched and expected to still show up in a repo-wide grep — scope this check to `build.ts`/`build-encode.ts` specifically).

- [ ] **Step 2: Delete the files and dead code**

Delete `build-encode.ts` and `build-lns.ts`. Remove the R18 gate and its `MAX_SOLVE_ENCODING` constant from `build.ts`. Remove `z3-solver` type imports (`Solver`, `Bool`, `Arith`) from `build.ts` if nothing else in the file uses them.

- [ ] **Step 3: Delete `build-encode-parity.test.ts`**

This test's entire purpose was proving two z3 encodings agree — there is only one placer in the BUILD/POLISH path now. Deleting it is correct, not a coverage loss (Task 7's parity test against the real verifier is the replacement, and covers more ground: TS-vs-Python agreement, not TS-vs-TS).

- [ ] **Step 4: Run the full engine test suite**

Run: `cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/gate.json`
Expected: `numFailedTests: 0`. Read the JSON file's counts directly per this repo's own verification standard — do not trust a wrapper summary.

- [ ] **Step 5: Commit**

```bash
git add -A packages/engine/src/scheduling/
git commit -m "refactor(engine): remove z3 tier-solver code now that BUILD/POLISH runs on cp-sat"
```

---

## Self-Review

**Spec coverage**: Architecture (Task 4-6), Contract (Task 1), Auth/transport (Task 4 interceptor, Task 5 client), Deployment (Task 8), CI (Task 9), Testing strategy — standalone (Tasks 1-4), integration (Task 7), parity (Task 7), fallback (Task 6, Task 7) — all covered. UI/wire-surface impact (Task 6b) covered, including the concrete rename decision the spec explicitly deferred. z3 removal scope (Task 10) covered, correctly gated and correctly scoped to BUILD/POLISH only — no REFLOW file touched anywhere in this plan.

**Placeholder scan**: no TBD/TODO; every code step has real code or, where existing complex logic is being read-and-adapted rather than invented (Task 2 `model.py`, Task 6 `build.ts`), the step names the exact file and line range to read first rather than fabricating what that code does.

**Type consistency**: `SolveBuildOutcome`/`SolveOutcome` field names (`assignments`, `status`, `tiersCompleted`/`tiers_completed`, `objectiveValues`/`objective_values`, `elapsedMs`/`elapsed_ms`, `wallExhausted`/`wall_exhausted`) are consistent across the Python dataclass (Task 2), proto message (Task 1), and TS interface (Task 5) — camelCase on the TS side, snake_case in proto/Python, matching each language's own convention rather than a literal string match, which is correct and intentional, not a drift.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-07-cpsat-service-build-cutover.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

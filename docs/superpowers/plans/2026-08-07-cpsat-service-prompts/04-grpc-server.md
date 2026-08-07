# Prompt 04: gRPC server — bootstrap, auth, health, request/response mapping

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
sections "Service architecture — framework & concurrency model" (why
`grpcio` sync + `ThreadPoolExecutor`, not `grpc.aio`) and "Internal
communication — auth & transport" (why shared-secret metadata, not
mTLS — 6PN is already WireGuard-encrypted, mTLS would add cert-rotation
cost for a threat model this repo doesn't defend against elsewhere).

**Acceptance criteria**: a request missing or wrong on the
`x-internal-secret` metadata key is rejected with `UNAUTHENTICATED`
before the solve ever runs. A well-formed, correctly-authenticated
request against the production board shape returns `OPTIMAL` or
`FEASIBLE`. Health check reports `SERVING`.

**Do not touch**: `model.py`/`objective.py`'s internals (Prompts 02/03)
— this prompt wires them into a server, it doesn't change how they
solve.

**Files:**
- Create: `services/cp-sat/src/cp_sat/config.py`, `services/cp-sat/src/cp_sat/schema.py`, `services/cp-sat/src/cp_sat/main.py`
- Test: `services/cp-sat/tests/test_config.py`, `services/cp-sat/tests/test_schema.py`, `services/cp-sat/tests/test_server.py`

**Interfaces:**
- Consumes: `cp_sat.model.build_model`/`solve` (Prompt 02/03), `cp_sat.generated.scheduler_pb2`/`scheduler_pb2_grpc` (Prompt 01).
- Produces: `SchedulerServicer` class registered on a `grpc.server`, listening on `config.PORT`, requiring metadata key `x-internal-secret` to equal `config.SHARED_SECRET`.

- [ ] **Step 1: Write `config.py` and its test first**

```python
# services/cp-sat/tests/test_config.py
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

- [ ] **Step 2: Write `schema.py`'s failing test**

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

Run: FAIL — add `grpcio-testing` to `pyproject.toml` dev deps first, then run again to confirm it fails on missing `cp_sat.main`.

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
Expected: PASS, all tests across Prompts 01-04 green.

- [ ] **Step 7: Commit**

```bash
git add services/cp-sat/src/cp_sat/config.py services/cp-sat/src/cp_sat/schema.py services/cp-sat/src/cp_sat/main.py services/cp-sat/tests/test_config.py services/cp-sat/tests/test_schema.py services/cp-sat/tests/test_server.py services/cp-sat/pyproject.toml
git commit -m "feat(cp-sat): gRPC server with auth interceptor, health check, request validation"
```

**Verify**: `cd services/cp-sat && venv/bin/python3 -m pytest tests/ -v` → all passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, confirm UNAUTHENTICATED rejection works, confirm health check reports SERVING.

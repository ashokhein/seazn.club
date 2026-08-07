# Prompt 01: Proto contract

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Contract: gRPC over a shared `proto/`" — read the field tables
there for *why* each field exists (e.g. why `wall_seconds` is always
server-clamped, why there's no `enabled_tiers` field). This prompt turns
those tables into the actual `.proto` file for the first time — they
were deliberately left as prose/tables during brainstorming, not
pre-written, so the schema wasn't locked before the design was approved.

**Acceptance criteria**: `proto/scheduler.proto` compiles with
`grpc_tools.protoc` to both Python and (later, Prompt 05) TS stubs.
Field names/types match the design doc's tables exactly — this is the
shared contract every other prompt in this index builds on; a mismatch
here becomes a bug in every downstream prompt.

**Do not touch**: anything outside `proto/` and this prompt's own test.
Do not generate TS stubs here — that's Prompt 05, which needs the TS
toolchain this prompt doesn't touch.

**Files:**
- Create: `proto/scheduler.proto`
- Test: `services/cp-sat/tests/test_proto_compiles.py`

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
Expected: FAIL — `grpc_tools` not installed, or nothing to compile yet.

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

**Verify**: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_proto_compiles.py -v` → 1 passed, 0 failed.

**Output cap**: final message under 15 lines — confirm both generated files exist, paste the pytest pass count, note any field you had to deviate on and why.

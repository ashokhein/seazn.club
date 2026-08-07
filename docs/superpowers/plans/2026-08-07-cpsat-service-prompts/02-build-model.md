# Prompt 02: BUILD model — promote from bench

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Investigation summary — BUILD/POLISH" — this is already-validated
code (14-point sweep, hand-rolled constraint checker, zero violations
across four constraint families). This prompt promotes it into the
service package; it does not redesign the model. If you find yourself
changing the modeling approach rather than adapting its inputs/outputs,
stop — that would be relitigating a decision already backed by real
benchmark evidence, not implementing this prompt.

**Acceptance criteria**: the production board shape from the
investigation (37 fixtures, 5 courts, 30/10 min match/gap) solves to
`OPTIMAL` with 35-37 assignments in under 8 seconds, verified by an
automated test, not manual inspection.

**Do not touch**: `services/cp-sat/bench/cpsat_bench.py`'s existing
sweep behavior — Step 2b extracts a shared helper but the sweep itself
must still pass after the extraction. Do not touch anything under
`packages/engine` — this prompt is Python-only.

**Files:**
- Create: `services/cp-sat/src/cp_sat/model.py`
- Test: `services/cp-sat/tests/test_model.py`
- Reference (read fully before writing): `services/cp-sat/bench/cpsat_bench.py`, `build_model` (line 596) and `run_full_chain` (line 843)

**Interfaces:**
- Produces: `build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies) -> cp_model.CpModel` and `solve(model, wall_seconds) -> SolveOutcome` with fields `assignments: list[tuple[str, str, int]]`, `status: str`, `tiers_completed: int`, `objective_values: list[tuple[str, int]]`, `elapsed_ms: int`. Prompts 03 and 04 import these exact names.

- [ ] **Step 1: Read the reference implementation**

Read `services/cp-sat/bench/cpsat_bench.py` lines 245-843 in full. Note
which parts are sweep-harness-specific (random board generation, JSON
progress logging) versus core modeling (interval vars, `NoOverlap`
calls, `symmetry_level=0`/`cp_model_probing_level=0` presolve settings
— these MUST carry over unchanged, they are the fix for the silent-
presolve-failure trap already on record for this exact model).

- [ ] **Step 2: Write the failing test using the proven production board**

```python
# services/cp-sat/tests/test_model.py
from cp_sat.model import build_model, solve

def _production_board():
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

Create `services/cp-sat/bench/cpsat_bench_boards.py` by moving the
production-board-shape generation code out of `cpsat_bench.py`'s sweep
list into a standalone `production_board()` function; re-import it back
into `cpsat_bench.py` so the existing sweep still runs unchanged. This
avoids a second, drifting copy of board-generation logic — the exact
class of bug the REFLOW investigation already hit once with
`syntheticBoard()` silently omitting blackout/hard-rule coverage.

Run: `cd services/cp-sat && venv/bin/python3 -m pytest bench/ -v` (confirm the existing sweep still passes after extraction)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_model.py -v`
Expected: FAIL — `cp_sat.model` does not exist yet.

- [ ] **Step 4: Write `model.py`, adapting `build_model`/solve loop from the bench**

Port `build_model` from `cpsat_bench.py:596-843` into
`services/cp-sat/src/cp_sat/model.py`, changing only: (a) inputs become
the plain-Python parameter list in the Interfaces block above instead of
the bench's `Board` dataclass; (b) wrap the solve loop into a
`solve(model, wall_seconds)` function returning `SolveOutcome`; (c)
strip sweep-only instrumentation. Keep `symmetry_level=0`,
`cp_model_probing_level=0`, and every interval/`NoOverlap` construction
byte-for-byte identical to the reference.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_model.py -v`
Expected: PASS — both tests green, production board OPTIMAL under 8s.

- [ ] **Step 6: Commit**

```bash
git add services/cp-sat/src/cp_sat/model.py services/cp-sat/tests/test_model.py services/cp-sat/bench/cpsat_bench_boards.py services/cp-sat/bench/cpsat_bench.py
git commit -m "feat(cp-sat): promote validated BUILD model from bench into the service package"
```

**Verify**: `cd services/cp-sat && venv/bin/python3 -m pytest tests/ bench/ -v` → all passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, production-board elapsed_ms and status, any deviation from the reference model and why.

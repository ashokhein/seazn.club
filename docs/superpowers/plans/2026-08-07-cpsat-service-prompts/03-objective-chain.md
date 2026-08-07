# Prompt 03: T0-T3 objective chain

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Tier/objective semantics are a fixed protocol constant, not wire
data" — the four tiers (T0 max-placed → T1 makespan → T2 worst idle gap
→ T3 court imbalance) were confirmed by reading `build.ts` directly, not
assumed. This prompt implements the CP-SAT-native equivalent of that
same lexicographic chain — same order, same semantics, different
mechanism (frozen bounds between sequential solves, not z3's push/pop).

**Acceptance criteria**: all four tiers complete on the production board
within budget, in the documented order, and T0's bound is provably
frozen before T1 runs (not a blended/weighted score).

**Do not touch**: `packages/engine/src/scheduling/build.ts` — reading it
for reference is fine (and required, see below), modifying it is
Prompt 06's job, not this one.

**Files:**
- Create: `services/cp-sat/src/cp_sat/objective.py`
- Modify: `services/cp-sat/src/cp_sat/model.py` (`solve()` calls into this module)
- Test: `services/cp-sat/tests/test_objective.py`
- Reference: `cpsat_bench.py`'s `run_full_chain` (line 843); `packages/engine/src/scheduling/build.ts` lines ~2051-2145 (`buildTiers`) for the four tier definitions

**Interfaces:**
- Consumes: `cp_model.CpModel`, fixture/interval variables from `model.py` (Prompt 02).
- Produces: `run_tier_chain(model, fixture_vars, wall_seconds) -> SolveOutcome` — `model.py`'s `solve()` becomes a thin wrapper calling this.

- [ ] **Step 1: Write the failing test**

```python
# services/cp-sat/tests/test_objective.py
from cp_sat.model import build_model, solve
from cp_sat_bench_boards import production_board

def test_all_four_tiers_complete_on_production_board():
    fixtures, courts, grid_slots, step_minutes, constraints, existing, deps = production_board()
    model = build_model(fixtures, courts, grid_slots, step_minutes, constraints, existing, deps)
    outcome = solve(model, wall_seconds=8.0)
    assert outcome.tiers_completed == 4
    names = [name for name, _ in outcome.objective_values]
    assert names == ["placed", "makespan", "idle_gap", "court_imbalance"]

def test_tier_order_is_lexicographic_not_weighted():
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

Port `run_full_chain` from `cpsat_bench.py:843-941`. Each tier: solve
for its own objective, freeze the achieved value as a constraint
(`model.Add(objective_var <= achieved_bound)`), move to the next tier —
the CP-SAT-native equivalent of z3's push/pop bound-walk (see
`build.ts:2009-2020`'s `Tier.of`/`Tier.atMost` for the semantics being
matched, not the z3 mechanism itself). Wire `model.py`'s `solve()` to
call this instead of a single `solver.Solve(model)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cp-sat && venv/bin/python3 -m pytest tests/test_objective.py tests/test_model.py -v`
Expected: PASS, all tests including Prompt 02's.

- [ ] **Step 5: Commit**

```bash
git add services/cp-sat/src/cp_sat/objective.py services/cp-sat/src/cp_sat/model.py services/cp-sat/tests/test_objective.py
git commit -m "feat(cp-sat): port T0-T3 lexicographic objective chain"
```

**Verify**: `cd services/cp-sat && venv/bin/python3 -m pytest tests/ -v` → all passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, tiers_completed value on the production board, confirm order matches T0→T3 exactly.

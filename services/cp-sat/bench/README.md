# CP-SAT scheduling bench

Standalone research prototype, not wired into any service or test suite.
Models the same fixture-scheduling problem this repo's z3 solver encodes
(`packages/engine/src/scheduling/build-encode.ts` / `build.ts`) using Google
OR-Tools CP-SAT, and sweeps it across board sizes comparable to
`packages/engine/scripts/bench-build.ts`, to answer: does CP-SAT clear
boards z3's `MAX_SOLVE_ENCODING` gate rejects, within the same wall budget?

Full writeup, methodology, and the corrected findings (an earlier pass's
optimistic result only held at `gapMinutes=0`; the realistic
`gapMinutes>0` case needed a genuinely different model — interval
variables + `AddNoOverlap` instead of a boolean fixture×slot grid) are in
[`docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`](../../../docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md).
Read that first — this README is just "how to run it."

## Headline result

The production board that motivated this investigation (37 fixtures, 5
courts, ~77k fixture-slots — always falls to greedy today, past the z3
gate) solves the full T0→T3 lexicographic objective chain to **proven
optimal in ~2.5s** with the current (interval/`NoOverlap`) model.

## Setup

```bash
cd services/cp-sat/bench
python3 -m venv venv
venv/bin/pip install -r requirements.txt   # ortools, pinned
```

Built and run against Python 3.9.6 / ortools 9.15.6755 locally; no
version-specific behavior relied on, should work on any modern CPython.

## Run

```bash
venv/bin/python3 cpsat_bench.py                    # full 14-point sweep
venv/bin/python3 cpsat_bench.py prod-37x77k         # filter to points whose label contains this string
```

Each point prints a JSON progress line as it completes (to stdout), then
a `=== SUMMARY ===` JSON array of every point at the end. Board
generation, constraint families modeled, and the model rewrite (v1 →
v2) are documented in the script's own module docstring — read that
before changing anything, it records several non-obvious traps already
hit and fixed (lattice re-spacing at `gcd(matchMinutes, gapMinutes)`,
CP-SAT's default presolve silently consuming the whole wall on this
board's heavy symmetry unless `symmetry_level=0` /
`cp_model_probing_level=0` are set, and why the objective chain is
sequential native solves rather than z3's push/pop bound-walk).

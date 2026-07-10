# PROMPT-14 — Simulation & Property-Test Harness

**Read first:** `engine/03-engine-architecture.md` §6; `engine/04-sport-scoring-specs.md`
§9; `engine/05-formats-progression-tiebreakers.md` §6; `development/12-quality-and-engine-correctness.md`
(v1 goals this supersedes). Preamble: PROMPT-00. Depends: PROMPT-04..09.

## Task
Build the cross-cutting harness in `packages/engine/src/testkit/simulation.ts` + a CI job:

1. **Tournament simulator**: for each registered sport module × each stage-graph template
   (league, group+KO, swiss+KO, DE, stepladder), generate a full division with random
   entrant counts (2–64), run every fixture with the module's `arbitraryEvent` stream to
   completion, progress all stages, and assert global invariants:
   - every fixture reaches a terminal status; no orphan feeds; champion well-defined
   - standings invariants (points conservation per fixture, played counts, ledger sums)
   - qualification counts; deterministic replay of the whole division (same seeds ⇒
     identical final standings, fixture ids, event ids)
   - random void injection: void a random event mid-tournament, refold — state remains
     valid and downstream progression recomputes consistently (or is correctly blocked
     when the stage already completed — assert the `rank_locked` guard).
2. **Chaos scorer**: interleave invalid events (wrong phase, unknown entrant, post-decision)
   — all rejected with typed codes, ledger never corrupted.
3. **Budgeted CI profile**: `SIM_RUNS` env (default 200 per sport×format in CI, 10k
   nightly via workflow_dispatch/cron job); failures dump the seed + event stream to an
   artifact for exact reproduction (`npm run sim:replay -- <seed>`).
4. Coverage gate for `packages/engine`: ≥ 90% lines, 100% on `core/` and
   `competition/tiebreakers.ts`.

## Acceptance
- CI job green; a deliberately seeded engine bug (mutation test: flip a comparator) is
  caught by the harness.
- `sim:replay` reproduces a failure deterministically from its artifact.

# PROMPT-03 — SportModule Contract, Registry & Conformance Kit

**Read first:** `engine/03-engine-architecture.md` §3; `engine/04-sport-scoring-specs.md` §9;
`engine/02-domain-model.md` §3–4; `engine/14-score-granularity.md` (adds `fidelityTiers`
and `officialLabel` to the contract). Preamble: PROMPT-00. Depends: PROMPT-02.

## Task
1. `sport/module.ts` — the `SportModule<Cfg, Ev, State>` interface exactly per 03 §3,
   including `positions: PositionCatalog`, `variants`, `metrics`, `defaultTiebreakers`,
   `supportsDraws`. `sport/catalog.ts` — `PositionCatalog` types + lineup validator
   (`validateLineup(catalog, lineup)` → typed errors: size, unique roles, group min/max).
2. `sport/registry.ts` — `register(module)`, `get(key, version)`, `latest(key)`; duplicate
   key+version registration throws; semver parse (tiny local impl, no dep).
3. `sports/generic/` — the v1-compatible module per 04 §8. First real module; proves the
   contract. Include `arbitraryEvent(state)` fast-check generator.
4. **`testkit/`** — exported `conformanceSuite(module, opts)` that any module's test file
   invokes; asserts every §9 cross-sport invariant:
   - purity/determinism of `apply`/`init`
   - outcome monotonicity over generated streams
   - points conservation vs `module.declaredPointsSets` (add to contract if needed)
   - integer/rational ledger check on `StandingsDelta` (no floats)
   - `summary` total on every prefix
   - config schema round-trip on every named variant
   - dual-fidelity equivalence hook (opt-in: module provides `coarsen(events)`)
5. Run `conformanceSuite(generic)` green.

## Acceptance
- Generic module passes conformance; toy module from PROMPT-02 migrated onto the kit.
- Registry version pinning tested (two versions of generic resolve independently).
- Docs updated if the contract needed fields the design missed (record deviations).

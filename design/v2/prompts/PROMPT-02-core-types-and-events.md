# PROMPT-02 — Core Types & Event-Sourcing Kernel

**Read first:** `engine/03-engine-architecture.md` §2, §7; `engine/02-domain-model.md` §6.
Preamble: PROMPT-00. Depends: PROMPT-01.

## Task
Implement `packages/engine/src/core/`:

1. `types.ts` — Zod schemas + types: `EntrantId`, `MatchOutcome` (all five kinds per 03 §3),
   `ScoreSummary`, `StandingsDelta`, `MetricSpec`, `LineupPair`, `StageKind`, `StageCtx`.
2. `events.ts` — `EventEnvelope<T>`; core event payload schemas (`core.start`,
   `core.void`, `core.forfeit`, `core.abandon`, `core.finalize`, `core.note` per 03 §2
   table); `resolveVoids(events)` (drops voided + void events; a void of a void re-enables —
   decide and test: **voids are not themselves voidable**, reject with `INVALID_EVENT`);
   `foldMatch(module, cfg, lineups, events)` exactly as specced.
3. `errors.ts` — `EngineError` with the code taxonomy of 03 §7; `.is(code)` helper.
4. `clock.ts` / `rng.ts` — injected time type; mulberry32 seeded PRNG with
   `shuffle(seed, items)` (deterministic Fisher-Yates) for draw-of-lots.
5. Kernel guarantees as executable tests (03 §2 list 1–4), written against a **toy
   in-file sport module** (coin-flip sport) so the kernel is testable before any real
   module exists: determinism, validation-before-append, void-refold equivalence
   (property test: for random valid streams, voiding event i ≡ folding without it),
   outcome monotonicity.

## Acceptance
- 100% branch coverage on `resolveVoids` and `foldMatch`.
- fast-check property: `fold(events) deepEquals fold(events)` and void-equivalence over
  ≥1000 generated streams.
- No boundary-gate violations.

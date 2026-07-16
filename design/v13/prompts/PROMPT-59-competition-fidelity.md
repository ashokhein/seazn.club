# PROMPT-59 — Competition fidelity: combined qualification + explicit bracket slotting

**Sport-agnostic.** Everything here is in the sport-**neutral** competition +
scheduling engine. It must behave identically for every `SportModule` (football,
cricket, tennis, hockey, badminton, board games, future sports). Add no
sport-specific branches; the goldens below span multiple sports on purpose.

**Read first:**
- `packages/engine/src/competition/qualification.ts` — `QualificationSpec =
  TakePicks | TopN | BestOfRank`, `qualificationSize`, `resolveQualification`,
  `orderCandidates`. This is where combined multi-tier qualification is added.
  Note the existing `BestOfRank.normaliseUnequalPools` — the "best thirds across
  unequal pools" logic that a combined spec must reuse, not reimplement.
- `packages/engine/src/scheduling/bracket.ts` — `buildSingleElim`,
  `generateSingleElim`, `seedPositions` (the standard fold), `crossPoolSeedOrder`,
  `nextPowerOfTwo`. `seedPositions(size)` is the only seeding today; explicit
  slotting is an alternative to it, threaded through `SingleElimOptions`.
- `apps/web/src/server/usecases/stages.ts` — the generation site: `case
  "knockout"` calls `generateSingleElim({ entrants: ids, seeds, ... })`, where
  `ids`/`seeds` come from `resolveQualification`. Also `snakeDistribute` +
  `POOL_KEYS` (pool `key` assignment) and `bracketToGen`.
- `apps/web/src/server/api-v1/schemas.ts` — `CreateStage.qualification`
  (currently a free `z.record`), `CreateStage.config`. Tighten/extend the
  qualification schema here.
- `packages/engine/src/competition/qualification.test.ts`,
  `packages/engine/src/scheduling/bracket.test.ts` — the golden/property tests to
  extend (identical-input-identical-output is a property test; keep it).

**Depends:** none. **Migration:** none (spec + config only).

## Context

Two sport-neutral primitives are missing, both exposed by seeding a real
48-team / 12-group / 32-qualifier cup, but they bite any real competition:

1. **Qualification is single-shape.** You can take pool picks, or top-N, or the
   best-of-one-rank — never a union. The canonical group→knockout field
   ("winners + runners-up + best thirds") isn't expressible; callers must
   flatten it into `TakePicks` by hand and recompute best-thirds themselves,
   losing `normaliseUnequalPools`.

2. **Brackets self-seed only.** `generateSingleElim` always places entrants by
   `seedPositions` (1 v N, 2 v N-1, folded). A real cup's **published slot map**
   (fixed pairings, third-place lookup, regional protection) can't be honoured,
   so the reproduced draw is never the real one.

Plus a papercut: `qualification.take[].pool` matches a pool's `key` ("A"), but
generated pools also carry `name` ("Pool A") and nothing says which to use —
passing the name silently qualifies nobody.

## Task

### 1. Combined multi-tier qualification (engine)

In `qualification.ts`, add a composing spec — the minimal shape that expresses
"several tiers concatenated into one ordered seed list":

```ts
export interface CombinedQualification {
  from?: string;
  combine: QualificationSpec[]; // each resolved against the same StageTables,
                                // results concatenated in declaration order
}
export type QualificationSpec =
  TakePicks | TopN | BestOfRank | CombinedQualification;
```

- `qualificationSize(combine)` = sum of child sizes.
- `resolveQualification(combine, tables)` = `combine.flatMap(child =>
  resolveQualification(child, tables))`. Each child reuses its existing logic —
  so `BestOfRank` inside a combine still applies `normaliseUnequalPools`.
- Keep it **pure + deterministic** (the existing property test must still pass
  for the combined shape: identical tables ⇒ identical seed list).
- Reject duplicates across children (same entrant qualifying twice) with a
  clear `EngineError("QUALIFICATION_INVALID", …)`.
- Validate `qualificationSize` still equals the next stage's input size (the
  existing spec-05 invariant).

This makes "all winners + all runners-up + best-N thirds" one spec:
`{ combine: [ {take:[…rank-1 of every pool]}, {take:[…rank-2…]},
  {bestOfRank:{rank:3,count:8,normaliseUnequalPools:true}} ] }`
— but nothing about it is football; the same shape serves a cricket Super-Six,
a hockey crossover, any pool→bracket sport.

### 2. Explicit bracket slotting (engine)

Extend `SingleElimOptions` with an optional explicit slot order that **replaces**
the standard fold:

```ts
interface SingleElimOptions {
  // …existing: entrants, seeds, thirdPlace, byeEntrants, idPrefix, bracketTag…
  /** Explicit round-0 slot order as seed numbers (1-based into the seeded
   *  entrant list), length = nextPowerOfTwo(n). When present it is used verbatim
   *  instead of seedPositions(size); a `null` slot is a bye line. */
  slotOrder?: (number | null)[];
}
```

- In `buildSingleElim`, when `slotOrder` is present use it in place of
  `positions = seedPositions(size)`; validate length = `nextPowerOfTwo(n)`, every
  non-null seed in `1..n` used at most once, bye count = `size - n`. Else behave
  exactly as today (no regression).
- Surface it through `stages.ts` `case "knockout"`: read `cfg.slotOrder`
  (validated) and pass it down. Standard behaviour when absent.
- This is the **generic** primitive: a caller supplies the published slot map;
  the engine does not know about any specific tournament.

### 3. Pool name vs key hardening

- In `resolveQualification` pool lookup (`poolByName`/`take[].pool`), accept a
  match on **either** `key` or `name` (normalise: strip a leading "Pool "
  prefix, case-insensitive), so "A" and "Pool A" both resolve.
- Document on `CreateStage.qualification` (schema comment) that `take[].pool` is
  the pool **key**, and add an `EngineError` that names the available pool keys
  when a pick resolves nothing (today it fails opaquely).

### 4. Schema

In `schemas.ts`, replace the free-form `qualification: z.record(...)` on
`CreateStage` with a discriminated/union zod schema mirroring the four
qualification shapes (recursive for `combine`), so bad specs 400 at the edge
instead of throwing deep in the engine. Keep `config.slotOrder` validated
(array of `number | null`).

## Tests (regression — each fails without its change)

- `qualification.test.ts`: a `combine` of `[take rank-1 ×G, take rank-2 ×G,
  bestOfRank rank-3 count-K]` over a synthetic 12-pool table yields G+G+K
  ordered seeds, best-thirds normalised, dupes rejected; property test
  (determinism) extended to the combined shape. **Add a non-football fixture**
  (e.g. a cricket-shaped 8-pool table) to prove sport-neutrality.
- `bracket.test.ts`: given `slotOrder`, round-0 pairings follow the map exactly
  (incl. bye lines); absent `slotOrder`, output is byte-identical to today
  (snapshot). A 32→bracket case with an explicit map.
- A usecase/API test: `POST …/stages` with a combined qualification + a
  `slotOrder` config round-trips and generates the expected first-round fixtures.

## Non-goals

- No named real-format presets ("wc48"). Ship the generic `combine` +
  `slotOrder` primitives; presets are a later, thin layer.
- No changes to double-elim / stepladder / swiss seeding (leave as-is; the
  `slotOrder` hook is single-elim only for now).
- No sport module edits.

## Help / docs pass (mandatory)

Update `content/help/*` where formats/qualification are explained (the
"Groups + Knockout" / advanced-formats help) to describe combined qualification
and custom bracket order in sport-neutral language — same PR, per repo rule.

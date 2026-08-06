# S6 — #416 (W5): PadSpec contract + bidirectional conformance

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S2's tier ruling, S3's lineup model, S5's variant-gating hand-off), then this.
Engine-only session. **The contract at the heart of ScoringPad v2.**

Branch `feat/s6-w5-padspec` in a fresh worktree. One PR. Issue #416.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part II, "PadSpec contract").

## Why

Eight hand-written pads each expose the subset of `eventSchema` their author
thought of, and nothing checks coverage. Making coverage a **conformance
property** inverts that: a sport module without a complete pad declaration fails
CI, and a new sport becomes scoreable with zero web-side work.

The completeness chain this session enforces the middle link of:

```
sport reality ⊇(S3/W4 audit) eventSchema/Cfg ⊇(THIS SESSION) PadSpec ⊇(S10 renderer) pad UI
```

## Scope

1. **`PadSpec` types in `packages/engine/src/sport/module.ts`**, plus a new field
   `padSpec(cfg: Cfg): PadSpec` on `SportModule` — a **pure function of resolved
   config** (base ⊕ variant preset ⊕ org overrides), data only, no React, no
   display strings:
   - **phases** `pre` / `live` / `post` — pre-match setup (toss, serve order,
     colour, lineup confirm), live scoring, post-match (`postDecisionTypes`,
     result confirmation).
   - **panels** — named ordered action groups, layout hints
     (`primary|grid|drawer|perSide`), optional gate predicates over folded
     `state`/`summary` (the super-over panel appears only when reachable).
   - **actions** — 1:1 with an `eventSchema` union branch: event `type`;
     parameter fields (enums/numbers/toggles) with bounds derived from `cfg`
     (`ballsPerOver`, best-of, …); attribution requirement
     `none | side | person(role?) | persons(n)`; a stable `labelKey` following
     the existing scoring-vocab pattern (engine declares keys + fallback labels,
     web dictionaries translate — see
     `../2026-07-16-scoring-vocab-i18n-design.md`).
   - **fidelity tiers** — `quick` (result-only) / `standard` (structured) /
     `full` (everything, person-attributed), formalising `fidelityTiers` already
     on `SportInfo`. **Check `_INDEX.md` for S2's tier-4 ruling before sealing
     the tier type.**
2. **`padSpec` on all 11 modules, per-variant correct**: cricket (over rhythm,
   extras, dismissals with fielder, reviews, super over, a DLS panel when
   `dls.enabled`), football (goals/cards/subs/period flow), the racquet + setbased
   family, the period family, boardgame (result + clock/forfeit + colour
   pre-match), carrom, generic. **The W4 `DOMAIN.md` dossiers are the checklist —
   every non-deferred fact must be reachable.**
3. **Conformance — padSpec block** for every builtin module × **every declared
   variant**:
   (a) every `eventSchema` union branch is reachable from some action (the full
   tier hides nothing);
   (b) every action property-generates payloads that `eventSchema` accepts,
   across its parameter bounds;
   (c) label keys unique and stable;
   (d) tiers nest `quick ⊆ standard ⊆ full`;
   (e) `DOMAIN.md` present (from W4).
   Plus: `padSpec(cfg)` is **deterministic** for a given cfg and **never throws**
   across all variant presets and generated org-override perturbations.
4. **Per-variant capability gating** — generalise it here; these are its
   acceptance cases, handed over from #431 item 5:
   - volleyball `beach` must **refuse** `volleyball.sub` (`records` is a *sport*
     flag today, so the kernel accepts it — beach has no substitutions);
   - hockey `youth` must not inherit adult 11-a-side or adult card durations
     (a 7-a-side youth match reports the wrong strength chip today);
   - icehockey `recreational` must not inherit the full IIHF ladder.
   Also from #431 item 6a: the hockey **shoot-out retake** must not overstate the
   attempt count.

Engine-only: no web files, no api-v1 change, no migration.

## Acceptance criteria

- [ ] All 11 modules declare `padSpec`; the conformance padSpec block is green
      for **every module × every declared variant**
- [ ] **Mutation proof**: deleting any single action from any module's spec makes
      conformance fail — do one per family, restore from a `cp` backup, never
      `git checkout` on uncommitted work
- [ ] An action emitting a payload outside `eventSchema` is impossible by
      construction, or caught by the property test
- [ ] Variant reshaping proven: `t20` vs `test` produce different panels/bounds
      from the same module; `hundred` honours its ball structure
- [ ] Tier nesting holds; `quick` alone reaches a decidable result for **every**
      sport (a result-only scorer is never stuck)
- [ ] beach refuses `volleyball.sub`; hockey `youth` and icehockey
      `recreational` no longer inherit adult rules — one regression test each,
      failing against today's behaviour
- [ ] Hockey shoot-out retake does not overstate the attempt count (regression)
- [ ] `padSpec` never throws for any cfg its `configSchema` accepts — property
      test over generated perturbations, not just the presets
- [ ] Engine purity gate green; `tsc EXIT=0`; engine + root lint `✖ 0 problems`
- [ ] Goldens byte-identical, or deliberate isolated re-baseline per S1
- [ ] `git diff --stat` is engine-only — **no `apps/web` diff**
- [ ] Vitest counts from the JSON reporter, no positional filter

### Test types

- **Unit** — spec shape per module, cfg-derived bounds, gate predicates.
- **Regression** — the three variant-inheritance bugs + the shoot-out retake,
  each failing today.
- **Conformance (bidirectional)** — the heart of this session; plus golden replay.
- **E2E (Playwright) + smoke: deferred to S12/S13** — the renderer that consumes
  PadSpec does not exist until S10. Say so in the PR body.

## Gotchas

- `padSpec` renders from the **pinned** module version at runtime (divisions pin
  a version and `registry.get(key,version)` has **no fallback**). Keep the
  function total for every cfg its `configSchema` accepts, not just the presets.
- **Label keys are API the moment they ship** — dictionaries and tests will
  anchor on them. Use the scoring-vocab naming convention; do not invent a
  second one. S7 translates exactly these keys.
- Gate predicates run **in the browser** in S10: pure data or serialisable
  predicate forms only, or both the engine purity gate and S10 break.
- A `SlotConfig` is structurally assignable to a `VerifyConfig` with fields
  undefined — the same shape of trap applies to any two cfg-ish types here. tsc
  cannot catch a dropped field; assert on values, and grep the builders.
- The placer/verifier fork is this repo's recurring bug: whenever two sides
  compute the same thing, extract one shared function and assert the same
  **number** from both sides.
- Modules stay `1.0.0`.

## Execution

Shared types in `sport/module.ts` + the conformance block land **inline first** —
everything depends on them. Then per-family `padSpec` declarations may go
parallel **only** with provably disjoint dirs: `{cricket}`, `{football}`,
`{setbased kernel + volleyball/badminton/tabletennis + tennis via nested kernel}`,
`{period kernel + icehockey/hockey}`, `{boardgame}`, `{carrom}`, `{generic}`.
Otherwise one sequential implementer → reviewer loop.

**Scout (sonnet) brief:** (a) `sport/module.ts` — the `SportModule` interface and
every implementer; (b) the conformance kit layout and how streams are generated;
(c) `fidelityTiers` on `SportInfo` and every read of it; (d) how variant presets
and org overrides resolve into cfg; (e) the scoring-vocab `labelKey` +
`MessageKey` convention. file:line table only, under 30 lines, no file contents.

**Implementer briefs** carry: the pinned scout table, S2's tier ruling, the
family's dir list, the explicit "do NOT touch other families' kernels" line, and
the verify command. Output cap as per `_RULES.md` §4.

**Reviewer (sonnet):** does every `eventSchema` branch have a reachable action —
or does conformance merely assert the spec is well-formed? Does any predicate
capture a closure that cannot serialise? Are bounds derived from cfg or hardcoded
from a preset? Gap list only.

## On close

`_INDEX.md`: S6 → DONE, the label-key convention as shipped (S7 input), the tier
model as sealed, the three variant-gating fixes confirmed. Memory: `padSpec` is
now the contract S10/S11 consume. Run `scripts/agent-memory-snapshot.sh`.

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
   - **fidelity tiers** — **S2/#430 ruled: reuse the fidelity ladder that already exists,
     mint no second vocabulary.** This brief previously said
     `quick`/`standard`/`full`; that was wrong and is superseded. The engine
     already declares `FidelityTier` at `sport/module.ts:63-67` as
     `{tier, eventTypes, entitlement?}` with `tier: z.union([z.literal(0..3)])`
     — a **numeric 0–3 fidelity ladder** ("the four-tier granularity ladder", `:61`), and
     `fidelityTiers` is already an **ordered array**, per sport, with each sport
     using the subset it needs (`carrom.ts:709-712` declares only 0 and 1).
     `padSpec` tiers ARE that number. A second string vocabulary would need a
     permanent translation table, and its drift means a free org pressing a paid
     button or a paying org locked out of one — the paywall reads the number
     (`apps/web/src/server/usecases/fidelity.ts:17-29`, free floor `tier <= 1`).
     **The fidelity ladder is CLOSED at 0–3 — S2/#430 ruled it, there will never be a
     `z.literal(4)`.** Do not add one, do not widen `tier` to an open `number`
     "just in case", and do not re-ask: the sealed union is the only check that
     a tier number means something to the paywall. The ten rows #430 parked are
     tier-3 work, not a fifth band — see the decision log.
     **Know this before you declare anything**: tier 3 is currently a
     **byte-identical duplicate of tier 2** in `football.ts`,
     `setbased/kernel.ts:912`, `nested/kernel.ts:1202` and
     `period/kernel.ts:1310` (same `eventTypes`, same entitlement), and
     `carrom`/`generic`/`boardgame` stop at tier 1. **Cricket
     (`cricket.ts:2392-2401`) is the only sport with a real four-band fidelity ladder** —
     tier 2 `cricket.player.line` → `stats.player`, tier 3 `cricket.ball` →
     `scoring.ball_by_ball`. Model `padSpec`'s tier semantics on **cricket**,
     which is correct, not on the duplicated majority, which is merely unfilled.
     Do NOT split the duplicated 2/3 in this session — that ships an event type
     and is out of scope. Do check whether the fidelity picker presents tier 3
     as a live choice where it is a duplicate (unverified by S2), and report it.
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
   (d) tiers nest — assert it by **iterating adjacent members of the module's
   declared `fidelityTiers` array**, never as hardcoded pairs. A module
   declaring only tiers 0 and 1 (carrom) must exercise the same assertion as one
   declaring 0–3, and a fifth band added later must be covered without editing
   the test;
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

5. **Two one-line carry-ins from S2/#430** (both rulings recorded in `_INDEX.md`,
   do not re-litigate):
   - **Fix the stale comment at `carrom.ts:114-116`.** It claims `apply()`
     rejects `carrom.strike`. It does not — `CarromStrike` (`:117-123`) is
     simply absent from the `CarromEv` union (`:125`), so `eventSchema` 422s the
     type structurally. `CarromStrike` **stays** (it is not an `eventSchema`
     branch, so acceptance (a) below never sees it and it needs no exemption);
     the other nine deferred #430 rows get **no typed placeholder and no
     reserved `scoring.*` key** — this stale comment is the argument against
     nine more of them.
   - **Honour the coverage invariant** in any tier-derived counter `padSpec`
     implies: *a derived statistic whose denominator depends on data the scorer
     may omit carries its own coverage counter, and is not emitted at all for a
     match whose coverage is partial* — enforced at **match** granularity. Third
     instance of this defect class (`metricOf` silent-0; optional
     `PeriodSetPiece.outcome`), so treat any new optional field folded into a
     tally as a defect until it has its coverage counter. S8/S9 inherit this.

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
- [ ] Tier nesting holds, asserted by iterating adjacent declared members (not
      hardcoded pairs); the **lowest declared tier** alone reaches a decidable
      result for **every** sport (a result-only scorer is never stuck)
- [ ] `padSpec` introduces **no second tier vocabulary** — `git grep -a` for
      `quick`/`standard`/`full` as tier names returns nothing new; tiers are the
      numeric `FidelityTier.tier`, and `module.ts:64` is **unchanged**, still
      sealed at 0–3 (`git diff` on that line must be empty)
- [ ] No module's `fidelityTiers` array is edited — the duplicated 2/3 split is
      later, separately-scoped work; PR body says so
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
(c) how variant presets and org overrides resolve into cfg; (d) the scoring-vocab
`labelKey` + `MessageKey` convention. file:line table only, under 30 lines, no
file contents. **Do not re-scout the fidelity ladder** — S2 pinned it (below).

**Pinned by S2/#430 against `main` @ `6eaea4fa` — re-verify, do not re-derive:**

| what | file:line |
|---|---|
| `FidelityTier` schema, `tier: 0\|1\|2\|3` sealed | `packages/engine/src/sport/module.ts:63-67` (`:64` is the union) |
| "four-tier granularity ladder" comment | `packages/engine/src/sport/module.ts:61-62` |
| the paywall that reads the number | `apps/web/src/server/usecases/fidelity.ts:17-29` (free floor `tier <= 1`, `:27`) |
| `SportInfo.fidelityTiers` on the web side | `apps/web/src/components/v2/fixture-console.tsx:140` (**not** `:132`) |
| web read sites | `.../f/[no]/page.tsx:148`, `score/[token]/page.tsx:139`, `v2/pads/period-pad.tsx:84`, `setbased-pad.tsx:39-40`, `tennis-pad.tsx:69-70` |
| engine read sites | `conformance/discipline.test.ts:28`, `testkit/golden.ts:282` |
| per-sport declarations | `carrom.ts:709`, `football.ts:1600`, `cricket.ts:2372`, `generic.ts:362`, `boardgame.ts:503`, `kernel.ts:912/1202/1310` (setbased/nested/period) |
| live `scoring.*` entitlement keys | `apps/web/src/lib/entitlement-domains.ts:29-37` — `ball_by_ball`, `rally_by_rally`, `match_timeline`, `device_links`. `scoring.strike_by_strike` is **not** a live key, only DOMAIN.md prose |
| `CarromStrike` + its stale comment | `packages/engine/src/sports/carrom/carrom.ts:114-116` (comment), `:117-123` (type), `:125` (`CarromEv`, which omits it), `carrom/index.ts:9` (re-export) |
| `PadSpec` in `packages/engine` | **absent** — greenfield, prose matches in `DOMAIN.md` only |

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

# S3 — #426 (W4b): mutable squads — lineup events, lineup→State, keeper identity

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Engine-only session. **Blocks S6 (W5).**

Branch `feat/s3-w4b-mutable-squads` in a fresh worktree. One PR. Issue #426.

## Why this blocks W5

What the schema cannot express by W5 can never reach a `PadSpec`, the renderer,
or a skin without reopening all three. A squad is fixed at match start and never
reaches `State` — **9 deferred rows across 7 sports share that one root cause**,
in the dossiers' own words:

- cricket, concussion/COVID replacement — "lineups reach the module through
  `init(cfg, lineups)`, not through the event stream; making a squad mutable
  mid-fixture is an architecture decision above this module".
- football — the goalkeeper is **never named in `State`**: "`squadFromLineup`
  keeps person ids and drops `positionKey`" … "blocked on W5's lineup model
  carrying positions into State".
- football, concussion substitution — "would need `Cfg.concussionSubs` and its
  own exemption from `maxSubs`".
- hockey, a side playing with no keeper — "the catalog REQUIRES exactly one GK,
  so a side playing without a keeper cannot be expressed in a lineup at all".
- icehockey, pulled goalie — "on-ice personnel rather than a scoring fact — the
  module deliberately has no substitution event".
- volleyball, libero replacements — "recorded on the libero control sheet … a
  product decision".
- tennis / tabletennis, doubles serve order — "enforcing the fixed rotation needs
  the pair's declared order, which is a lineup-layer fact".

**The trap to name out loud:** no goalkeeper statistic is derivable at all —
clean sheets, saves, goals conceded — in either hockey code or football, because
the fold never learns who the keeper is. That is the most-requested keeper stat
set, it looks like an S9 (career rollup) feature, and a rollup built before this
lands would be designed around a person the fold does not have. S9 depends on
this session, not the other way round.

## Already done in W4 — do NOT redo

- `LineupSlot` already carries a shirt number (`e6266e80` range).
- `positionsFor(cfg)` already resolves the catalog per variant, so football's
  `small-sided` and a pulled keeper in both hockey codes are expressible **at the
  catalog level**.

What is missing is the **event** that changes who is on the field, and positions
**surviving into `State`**.

## Product decisions to settle before code

Ask the owner in-session. Do not guess, do not file an issue. Record each answer
in `_INDEX.md` the moment it is given.

1. May a squad **grow** mid-fixture (a concussion replacement adds a person not
   named at start), or only permute the named squad?
2. Is a person substituted **off** ever eligible to return? Per sport, per variant.
3. Does a **coach or team official** exist in the person model at all? (A card to
   a coach currently lands in the player stat table — S4 shares this decision.
   Settle it once, here, since this session lands first.)

Bring a recommendation for each, with the cost of each branch, rather than an
open question.

## Scope

1. **A `core.lineup.*` event family** — one kernel-owned model, the way
   `core.suspend`/`core.resume` landed in W4, rather than eleven private
   solutions: substitution, replacement (concussion/injury, with its exemption),
   keeper change, libero swap, retirement.
2. **Positions survive `init` into `State`**, so the keeper — and any
   position-keyed role — is nameable at any point in the fold. This is the fix
   that unlocks keeper stats in S8/S9.
3. **Pair/doubles declared order reaches `State`** so serve rotation can be
   enforced or checked (tennis, tabletennis).
4. **Per-sport exemptions live in config, not hard-coded**: concussion subs
   outside `maxSubs`, rolling subs, unlimited subs. Config-driven so a variant
   reshapes them, per the same rule W5 will rely on.

Then walk the 9 deferred rows above and close each one, or record in `_INDEX.md`
why it does not close here.

## Acceptance criteria

- [ ] `core.lineup.*` family exists once, kernel-owned; every sport that needs it
      consumes the shared model — grep proves no per-sport reimplementation
- [ ] Football: the goalkeeper is nameable from `State` at any fold point,
      including after a keeper change; test asserts the **identity**, not merely
      that a field exists
- [ ] Hockey: a side with **no** keeper is expressible in a lineup and folds
- [ ] icehockey: a pulled goalie is representable
- [ ] volleyball: a libero replacement records and folds
- [ ] tennis / tabletennis: doubles declared order reaches `State`; a rotation
      check can read it
- [ ] cricket + football: a concussion replacement is accepted and is **exempt
      from `maxSubs`**, driven by config, with a test where the exemption and the
      cap disagree
- [ ] A person substituted off behaves per the ruling from decision 2 — test both
      the allowed and the refused direction
- [ ] Additive only; **goldens byte-identical** (if any golden must move, it is a
      deliberate isolated re-baseline commit per S1's new policy, with a state
      diff in the PR body); modules stay `1.0.0`; zero new runtime dependencies
- [ ] Engine purity gate green; conformance green for all 11 modules × variants;
      `tsc EXIT=0`; engine lint `✖ 0 problems`
- [ ] Vitest counts from the JSON reporter, **no positional filter**

### Test types

- **Unit** — event schema branches, fold transitions, config-driven exemptions.
- **Regression** — one per closed deferred row, each failing without the change;
  in particular a keeper-identity test that fails against today's
  `squadFromLineup` behaviour.
- **Conformance** — every new event branch reachable and folded, all modules ×
  variants; **golden replay** byte-identical.
- **E2E (Playwright) + smoke: deferred to S12/S13** — engine has no surface this
  session. Say so in the PR body.

## Gotchas

- `eventSchema` validates the **payload only** — the `type` lives on the
  envelope. A new event type is 5 coordinated edits, and a `z.union` matches
  first-branch-wins, silently swallowing siblings. Write the test that would
  catch a swallowed sibling.
- `at` records only what the fold **cannot** derive. Do not stamp derivable state
  into lineup events.
- A cfg-derived **throw** inside a fold permanently bricks recorded fixtures —
  cfg is read live and the stream replays on every read. Found 6× in W4a. Refuse
  by returning a rejection, never by throwing.
- Kernel edits blast wider than one sport: name the blast radius in every
  implementer brief.
- The catalog requiring exactly one GK is a **catalog** constraint — check
  whether `positionsFor(cfg)` already relaxes it before adding a second mechanism.

## Execution

The kernel model (scope 1–2) is one interlocked file set → **one inline
implementer pass**, batching rule. Per-sport adoption (scope 3–4 and the 9 rows)
may go parallel **only** if the file sets are provably disjoint — the racquet
trio and tennis share the nested/setbased kernels and must travel together.

**Scout (sonnet) brief:** map (a) how `core.suspend`/`core.resume` are declared
and folded — that is the pattern to copy; (b) `init(cfg, lineups)`,
`squadFromLineup`, `positionsFor(cfg)` and where `positionKey` is dropped;
(c) the `State` shape per family kernel (`setbased/kernel.ts`, `nested/kernel.ts`,
`period/kernel.ts`); (d) where `maxSubs` is read. file:line table only, under 30
lines, no file contents.

**Implementer (opus, high):** carries the three product rulings verbatim in its
brief, plus the pinned line table from scout. TDD, failing-first tests.

**Reviewer (sonnet):** is the lineup model genuinely shared, or reimplemented per
sport? Does any fold throw on a cfg-derived condition? Does the keeper test
assert identity or mere presence? Are goldens byte-identical? Gap list only.

## On close

- `_INDEX.md`: status S3 → DONE, the three product rulings in the decision log,
  the coach/person-role answer flagged as **input to S4**, and any of the 9 rows
  left open with its reason.
- Memory: keeper identity now in `State` (it changes what S8/S9 can compute).
  Run `scripts/agent-memory-snapshot.sh`.

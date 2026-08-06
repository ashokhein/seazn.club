# S1 — #429: golden corpus — deliberate re-baseline, schema snapshots, slimming

Paste this whole file as the session opener. First actions, in order:
read `_RULES.md`, then `_INDEX.md`, then this brief. Engine-only session.

Branch `feat/s1-golden-corpus-policy` in a fresh worktree. One PR. Issue #429.

## Why this is first

W4 froze a golden replay corpus for all 11 sports (`55b77714`) because engine
conformance generates its own streams with fast-check at run time — it can only
ever test the present, so it cannot notice a schema narrowing or a fold change.
The corpus works: it killed every mutation thrown at it across six agents.

It has also become the binding constraint. **Five correctness rows are deferred
purely because fixing them would move a golden:**

- icehockey — overtime played 3-on-3: `Cfg.overtime.skaters` is parsed and then
  **dropped — dead config today**. Two states in the frozen corpus are in OT with
  a penalty running, so the strength chip they recorded would change.
- icehockey — the game-winning-shot winner's +1 goal in the official score:
  changing it rewrites existing folds and every standings row.
- icehockey — auto early-release of a minor on a powerplay goal: changes how an
  already-recorded goal payload folds.
- hockey / icehockey — conversion rate as a standings metric: adding it
  unconditionally changes the frozen golden deltas; needs absent-key semantics.

Every later session in this programme adds events and folds. Unblock the rule
now or each one inherits the deadlock.

## Scope

1. **Replace "never re-baseline" with "never re-baseline silently."** The freeze
   rule was written to protect divisions pinned to a module version. There is no
   production data — the same reasoning is why W4 skipped version bumps. New
   policy, written into the testkit's own docs and enforced by the harness:
   a re-baseline is legitimate only when it is **deliberate, isolated in its own
   commit, and reviewed as a state diff**. Never a side effect of another change;
   never `UPDATE_GOLDEN=1` run to clear a red. Make the harness make this true —
   at minimum a re-baseline run must fail unless it is the only change in the
   working tree, and must emit a reviewable state diff summary.
2. **Schema-shape snapshots.** Goldens prove folds did not change; they prove
   schemas did not narrow only where a recorded stream happens to exercise them.
   Dump each module's JSON Schema (`configSchema`, `eventSchema`, and the state
   shape) to a committed file per module and diff it in CI. Catches a narrowing
   with no golden coverage, and is far cheaper to review than 2.2 MB of state.
3. **Slim the corpus.** 2.2 MB of JSON for 11 sports, growing per sport. Move to
   per-step state **digests** plus a handful of full states — same tripwire, a
   fraction of the weight. Prove equivalence: the slimmed corpus must still kill
   the mutations the full one killed (keep a documented mutation list).
4. **Close two residual weaknesses**, both recorded during W4's shared-core pass
   and verified non-live against all 11 corpora today:
   - `stateMismatch`'s subset branch keys off the literal top-level name `cfg`.
   - `withoutCfg` re-serialises through a `JSON.parse` round-trip, so
     integer-like keys would reorder. No corpus currently has any — write the
     test that would have caught it, then fix.
5. **Then take the five deferred rows** the old rule blocked — starting with
   icehockey `Cfg.overtime.skaters`, which is dead config parsed and dropped.
   Each fix lands with its own deliberate re-baseline commit, state diff in the
   PR body. If any of the five turns out to be more than a session's work, do the
   ones that fit, and say plainly in the PR which were left and why — do not open
   an issue for them, put them in `_INDEX.md`'s decision log.

## Acceptance criteria

- [ ] Re-baseline harness: a golden update fails unless it is isolated in its own
      commit; it prints a reviewable state diff; `UPDATE_GOLDEN=1` mixed with
      other working-tree changes is refused. **Test that fails without it.**
- [ ] Schema snapshot per module committed; CI diffs it; a deliberately narrowed
      enum in any one module fails the snapshot test (mutation-proved, restore
      from a `cp` backup — never `git checkout`)
- [ ] Corpus slimmed; total committed golden bytes reported before/after in the
      PR body; the documented mutation list still all-red against the slim corpus
- [ ] `stateMismatch` no longer keys off the literal name `cfg` — test with a
      nested key named `cfg` and a top-level key that is not
- [ ] `withoutCfg` round-trip is order-stable — test with integer-like keys
- [ ] `Cfg.overtime.skaters` is live: a 3-on-3 OT with a penalty running produces
      the correct strength chip, re-baselined in its own commit
- [ ] Every other of the five rows either fixed (own commit + state diff) or
      recorded in `_INDEX.md` with the reason it did not fit
- [ ] Engine purity gate green; `npx tsc --noEmit; echo "EXIT=$?"` → `EXIT=0`;
      `rtk proxy npm run lint` → `✖ 0 problems` for root **and** `@seazn/engine`
- [ ] Vitest counts pasted from the JSON reporter, full engine suite
- [ ] `git diff --stat` is engine-only — no `apps/web` files

### Test types

- **Unit** — harness behaviour, `stateMismatch`, `withoutCfg`, digest equivalence.
- **Regression** — one per deferred row fixed, failing without the fold change;
  plus the two residual weaknesses.
- **Conformance + golden replay** stand in for e2e here (engine has no surface).
- **E2E (Playwright) + smoke: deferred to S12/S13** — no user-reachable surface
  exists in this session. State that explicitly in the PR body.

## Gotchas

- `UPDATE_GOLDEN=1` to make a red go away is exactly what this session exists to
  stop. If you find yourself reaching for it mid-work, that is the bug.
- Conformance generating its own streams is why the corpus exists — do not
  "simplify" by folding one into the other.
- A cfg-derived throw inside a fold permanently bricks recorded fixtures: cfg is
  read live and the stream replays on every read. Found 6× in W4a.
- Digest choice must be order-insensitive where the state genuinely is a set, and
  order-**sensitive** where order is meaning. Getting that backwards makes the
  tripwire silently vacuous.
- Modules stay `1.0.0`. No bumps.

## Execution

Single inline implementer pass — testkit, harness and all 11 corpora are one
interlocked file set (batching rule). Scout first, then implementer, then
reviewer, then rerun the gate inline.

**Scout (sonnet) brief:** map `packages/engine/src/testkit/` — golden-compare
harness, `stateMismatch`, `withoutCfg`, the `UPDATE_GOLDEN` path, where corpora
are written and read, and where the conformance kit asserts `DOMAIN.md`. Return a
file:line table only, under 25 lines, no file contents.

**Implementer (opus, high):** the five scope items above in order; TDD; every
change ships a failing-first test; re-baselines isolated per commit.

**Reviewer (sonnet):** does the slim corpus still kill every mutation on the
documented list? Is any re-baseline mixed into a functional commit? Is the schema
snapshot actually diffed in CI or merely written? Return a gap list only.

## On close

- Update `_INDEX.md`: status S1 → DONE, the new re-baseline policy in the
  decision log, before/after corpus bytes, any of the five rows left undone.
- Write memory: the policy, and any new gotcha found. Run
  `scripts/agent-memory-snapshot.sh`.
- Existing memory `engine-golden-corpus-additive-tripwire` says "NEVER
  `UPDATE_GOLDEN=1`" — that memory is now **wrong in detail**; update it to the
  new deliberate-re-baseline rule rather than leaving a contradiction.

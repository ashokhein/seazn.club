# S13 — #422 (W11): cutover — delete v1 pads, help + smoke, programme close

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(the v1 deletion inventory from S12 — it is the work list), then this.

Branch `feat/s13-w11-cutover` in a fresh worktree. One PR. Issue #422.
Closes the programme; #407 and #411 can close when this merges.

## Why

**A flag that never flips is a second dispatcher with better marketing.** S12
proved v2 end-to-end behind the flag; this session makes it the only path and
pays the closing costs every branch owes — help, smoke, i18n audit, a11y.

## Scope

1. **Flip and delete**: remove the flag **entirely** (not default-on — gone).
   Delete `apps/web/src/components/v2/pads/{cricket,football,setbased,tennis,period,boardgame,generic,carrom}-pad.tsx`,
   the v1 dispatch branches in `fixture-console.tsx` and `device-score-pad.tsx`,
   and every import S12's inventory listed. `scoring-vocab.ts`'s hardcoded
   sport-key union: derive it from the engine module keys, or add a drift test —
   **no third list survives.**
2. **e2e re-anchor**: update v1-pad-anchored selectors and text across **both**
   e2e phases to the v2 surfaces. Grep the deleted components' testids and
   strings across `e2e/` **before** deleting them.
3. **Help pages** — `content/help/**`, one English tree, no i18n owed: scoring a
   match with v2 — choosing a fidelity tier, pre-match setup, attribution,
   offline behaviour, corrections/void, device-link handoff. Update any existing
   scoring help that still shows v1.
4. **Smoke**: extend `scripts/smoke.ts` pro **and** free paths to score a fixture
   via the v2 append path through to a decided result (`quick` fidelity is the
   designed minimal path). This discharges the smoke debt deferred by S1, S3–S8,
   S10 and S11 — check `_INDEX.md`.
5. **Final audits**: `i18n:gen-keys` + `i18n:check` across the whole scorepad
   tree; an a11y pass on the live surface (focus order, hit targets, contrast —
   courtside sunlight is the real use case); `/admin` untouched (staff-only bar).
6. **Full local verification before the PR**: complete unit sweep (JSON
   reporter), lint via `rtk proxy` for root **and** engine, `tsc` with
   `EXIT=$?` and the raised heap, prod-build e2e **both phases**, openapi drift
   if anything moved.

## Acceptance criteria

- [ ] No file imports a v1 pad; the eight components are gone;
      `git grep -a` for each deleted component name returns nothing
      (`-a` matters — this repo reports source files as `Binary file … matches`)
- [ ] The flag is **removed**, not defaulted on — grep proves no reference remains
- [ ] Exactly **one** sport-key list survives (the engine's), or a drift test
      pins any projection of it (mutation-prove the drift test)
- [ ] Both e2e phases green locally on the prod build, counts pasted; no
      assertion references a deleted surface
- [ ] Help tree covers v2 scoring end-to-end; no v1 screenshots or steps remain
- [ ] `smoke.ts` scores through v2 on **both** pro and free paths
- [ ] Every deferred test obligation listed in `_INDEX.md` is now discharged or
      explicitly, permanently accepted with a reason
- [ ] i18n ×4 audit green; `openapi:gen` + `i18n:gen-keys` run, then
      `git status --porcelain` **empty**
- [ ] Final screenshots (console + device pad, desktop **and** 375px) attached
- [ ] a11y pass recorded: focus order, hit-target sizes, contrast ratios
- [ ] PR body carries the full gate output **and** S12's inventory checklist, all
      ticked

### Test types

- **Unit** — the sport-key drift test; anything the deletions expose.
- **E2E (Playwright)** — both phases, re-anchored, green on a prod build.
- **Smoke** — v2 scoring on pro and free paths.
- **Regression** — the drift test; a test that fails if a v1 pad file returns.

## Gotchas

- **Deletion order: re-anchor e2e first, delete second** — otherwise every
  intermediate commit is red.
- `git checkout <file>` on uncommitted work restores the index and deletes the
  implementation. During a deletion sweep, back up with `cp`, never `git checkout`.
- Help-tree edits owe **no** i18n, but any new in-app string does. The boundary
  is `content/help/**` exactly.
- Smoke CI runs on **PRs only** — this must go through a PR, not a local merge
  and push.
- e2e: `localhost` not `127.0.0.1`; assert port 3100 is your own PID; a parallel
  phase failure means serial + mobile never ran.
- Do not dispatch a subagent to run e2e — the 600s watchdog has killed two.
- Deleting eight components will surface dead i18n keys. Remove them in all four
  dictionaries, and re-run `i18n:check` after.

## Execution

Deletion sweeps do not parallelise → **one inline implementer pass**, sequential.

**Scout (sonnet) brief:** a `git grep -a` sweep of every reference to the eight
v1 pad components, the flag name, and the `scoring-vocab.ts` key list — across
`apps/web`, `e2e/`, `scripts/`, `content/help/`. Return a file:line table only,
grouped by target, under 40 lines, no file contents. Cross-check it against S12's
inventory in `_INDEX.md` and report any difference — a difference means S12's
inventory was incomplete, which is itself the finding.

**Implementer (opus, high):** brief carries the merged inventory, the
re-anchor-before-delete ordering, and the full ship checklist.

**Reviewer (sonnet):** does any e2e assertion still reference a deleted surface?
Is the flag genuinely gone? Is there still more than one sport-key list? Did any
dead dictionary key survive? Gap list only.

## On close — programme close

- `_INDEX.md`: S13 → DONE; mark the programme **CLOSED** with the date; carry
  forward any permanently-accepted deferral.
- Close #422, #411 and #407 with a comment pointing at this PR.
- Verify #430's ruling is recorded (it may still be parked — that is fine, but it
  must be written down, not left in conversation).
- Write the closing memory: what shipped, the architecture as built (not as
  designed), and every gotcha the programme discovered. Run
  `scripts/agent-memory-snapshot.sh`.
- Update the memory `scoringpad-v2-programme` from "DESIGN ONLY" to shipped.

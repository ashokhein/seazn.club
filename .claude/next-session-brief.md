# Next session brief — scheduling / engine correctness lane

Written 2026-08-04, end of the #451 session. Supersedes the previous brief.

## State on arrival — nothing is left open from this lane

`main` is at **`1f56bd5e`**. All work from the last two sessions is merged, all
worktrees removed, all branches deleted.

| merged | what |
|---|---|
| `528985b3` (#464) | #446 + #447 + #459 — group ids, durable hard rules, one rest semantics |
| `ba889011` (#466) | #452 — smoke + e2e for the scheduling constraint surface |
| `1f56bd5e` (#468) | #451 — DLS reads the table on its own scales |

Filed this session and still open: **#467** (nothing renders `revisedTarget`).

**GitHub does NOT auto-close on a bare `(#451)` in a commit subject.** Put
`Closes #NNN` in the PR *body*. Three issues had to be closed by hand before I
started doing this.

## START HERE — #448, officials day cap

I re-verified all seven remaining backlog premises against `origin/main` this
session (by content, not line number — every one still holds). **#448 is the
only one that produces a wrong outcome in the world rather than an unenforced
rule**, so it should go first.

`packages/engine/src/officials/assign.ts:40`

```ts
return basis === "tournament" ? "T" : new Date(startAt).toISOString().slice(0, 10);
```

That is the **UTC** calendar day, and it buckets both the hard `maxPerDay` cap
(`:204-206`) and `fairness: "per_day"`. The comment claims the caller owns time
zones; **no caller shifts.** `apps/web/src/server/usecases/officials.ts:558`
loads `venue_tz` and never passes it (`:367`), and `OfficialFixture` carries no
tz field at all.

Concrete: org in `America/Los_Angeles`, official capped at 2/day, Saturday
fixtures at 10:00 / 12:00 / 18:00 / 20:00 local. The 18:00 and 20:00 land on
**Sunday UTC**, so the cap counts 2 + 2 and assigns all four with zero
conflicts. Four games on one local Saturday against a cap of two.

Every org west of UTC with evening fixtures is exposed; every org east of UTC
with early-morning ones. The codebase already disagrees with itself —
`officials-ai.ts:503` uses the **local** day for blackouts, `:570` the **UTC**
day for the recount.

Design note before coding: the org-tz convention in this repo is that **org tz
governs all time** (see the verified-scheduling programme). `OfficialFixture`
needs a tz or the caller needs to shift; decide which, and make the placer and
the recount use the SAME day key — this is the officials instance of the
placer/verifier fork.

## Then, in order

Ranked by whether a user is actually harmed, not by filing order.

2. **#463 — placer honours only the rest family.** Confirmed: `slotFixtures`
   folds rest, `startWindows` and `crossPersonClash` and nothing else, so
   `max_fixtures_per_day`, `not_before`/`not_after`, `fixture_on_weekday`/
   `fixture_on_date` and `feeder_to_dependent` rest are reported but never
   placed around. **Take the person-pair item first** (see the issue comment):
   `lastEnd` is keyed by `EntrantId`, so a `per_person` rule between fixtures
   sharing a person but no entrant is still placer-blind. That is the central
   case and it is much smaller than the day-cap/window design work.
3. **#458** — `schedule-ai.ts:1606` pins `startWindows: []`. Fix is a copy of
   either sibling (`schedule.ts:400-404` or `competition-schedule-ai.ts:1308`).
   The file's own comment at `:1458` already documents it as a defect. #464
   added an assertion pinning the current behaviour — flip it.
4. **#462** — `siblingAssignments` returns `Assignment[]`, so cross-division
   fixtures arrive with no `RuleFixture` and a competition-scoped day cap
   undercounts. The joint path gets this right; copy it.
5. **#449 + #450 — do as ONE paired wave.** Same bug class, same file
   (`calendar.ts:651` and `:655`), and both are labelled `verified-scheduling`.
   #449: `scope.pool` is compared against a pool **key** (`"A"`, from
   `poolKey.get(...)` at `schedule-ai.ts:978`) while `restByGroup` keys and
   `startWindows.target.id` in the SAME constraints object are pool **uuids**.
   #450: `guardedPeople` (`:630`) maps every id through `identity.keyOf`,
   replacing a collapsed person's uuid with `name:<normalised>`, so a
   person-scoped rule stops binding the moment a second person shares a name.
6. **#461** — `moveFixture` returns `Promise<void>`, so it cannot return the
   conflicts it computes. Missing feedback, not a wrong answer.

Also open, not triaged this session: #465, #455, #453, #439, #402, #389, #388.

## THE bug class — keep hunting it

**A value that exists on one side of a seam and is silently absent, or in a
different namespace, on the other — where both sides typecheck.**

Seven instances now: #443 (uuid vs ext_key), #446 (Assignment group ids), #447
(`SlotConfig` assignable to `VerifyConfig` with `tz`/`hard`/`ruleFixtures` all
undefined), #449 (pool key vs uuid), #450 (person name vs uuid), #451 (cfg
scales vs table scales), #448 (UTC day vs local day).

The tell is always: **two producers, one comparison, no normaliser.** Grep the
BUILDERS, not the types — tsc cannot see any of these.

## Lessons from the #451 session that will save you real time

- **The issue's own suggested fix was wrong, and so was my memory note
  recommending it.** #451 floated "gate `r1`/`r2` on `dls.enabled`, maybe the
  corpus reconciles free". One census killed it: **24 of 27 golden streams**
  carry a non-null `r1`, not the 5 the issue implied. Before choosing a fix
  shape, census the corpus for the field's **distribution**, not one example.
- **Three issue premises in a row have been wrong on the details** (#452 claimed
  no bracket existed — one did; #447 asked for 4 new call sites — they already
  existed). Read the source before accepting the diagnosis. The *defect* has
  been real every time; the *explanation* often is not.
- **`REBASELINE_GOLDEN` is the sanctioned minimal regeneration** — it refreshes
  derived state and keeps the event ledger and each stream's `cfg`
  byte-identical. It is NOT the banned `UPDATE_GOLDEN`. Prove minimality with a
  structural diff script; do not eyeball a 1.8M single-line JSON.
- **The golden corpus cannot catch what no config exercises.** `playersPerSide`
  is 11 in every recorded stream, so the corpus was structurally incapable of
  catching the DLS wickets bug. A green corpus is not coverage.
- **An invisible output is an unverified output.** #451 survived because nothing
  renders `revisedTarget` (#467). When a derivation has no visible surface,
  assume nobody has ever checked it.
- **Two subagents died mid-task** (one API error, one 600s stall). Both left the
  tree clean; the stalled one left a probe script that turned out more useful
  than its report would have been. Check `git status --porcelain` after any
  agent failure, then re-dispatch — don't assume corruption.
- **Run timing gates alone.** `repair-scale`'s 500-movable wall-clock assertion
  failed at 8941ms with a reviewer agent running, 7612ms as load fell, and
  passed **4/4 in isolation** at load 7.67. Never judge it from a full parallel
  suite run.

## Environment

Read the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`)
before standing anything up. The traps that cost the most:

- **A Postgres on a shared port may belong to another session.** Check
  `show data_directory` matches YOUR scratchpad. A `pg_ctl` that fails with
  "Address already in use" is followed by a `createdb` that SUCCEEDS against the
  foreign server. This session's agent correctly declined the borrowed DB and
  stood up its own on `:54333`.
- `db:apply` alone is not a fresh schema — it needs `sync:sports`.
- **After ANY rebase onto a moved main, re-run `db:apply` before believing a red
  suite.** A mid-session migration produced 91 failures across ~24 unrelated
  suites; the tell is `PostgresError: column "…" does not exist`.
- `:3000` is the owner's dev server — leave it alone. `:3100` for
  `E2E_PROD_TARGET`, `:3200` for a standalone smoke server.
- `output: standalone` means **`next start` returns 200 while serving the wrong
  server.** Use the skill's §3 recipe and verify a `/_next/static/*.js` asset
  returns 200, not just the HTML.
- A worktree needs a real `npm ci` (symlinked `node_modules` compiles MAIN's
  engine), plus symlinked `.env.local` (root + `apps/web`) and
  `.claude/agent-memory` (or every subagent there runs blind).

## Verification rules that earned their keep

- Judge vitest green ONLY from `--reporter=json --outputFile`. Note
  `numFailedTestSuites` counts failed **describe blocks**, not files — it will
  not reconcile with the file count, and that is not a collection failure. The
  real collection tell is a suite with **zero** `assertionResults`.
- **The engine has its own lint task** (`@seazn/engine#lint`) that the repo-root
  `npm run lint` does NOT cover. Run both, via `rtk proxy`, and read `✖ N problems`.
- Prefix `cd <abs worktree> &&` in the SAME call as anything you judge. cwd
  resets between calls, and it bit me again this session mid-way through a gate.
- **Never `git stash` in a worktree** — the stack is shared with the main
  checkout. Revert-to-prove with `git show <ref>:<path> > <path>` + `cp` backups.
- Always `grep -a`.
- Never run `UPDATE_GOLDEN=1`. Never enable `.github/workflows/e2e.yml`.
- Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it.

## Standing instructions (owner)

- **Skills:** load and USE all `superpowers` skills, `frontend-design`, `stripe`,
  `playwright`, `supabase`, `typescript-lsp`, `code-review`, `seazn-local-env`.
  Apply them where they help — do not just cite them.
- **Mindset:** think past the literal request. Hunt gaps, edge cases and weak
  design; propose improvements, don't only implement what was asked.
- **Schema:** greenfield. No production data, no backfills. New tables/columns
  are fine and expected — prefer a CORRECT schema over a compatible one.
- **Topology:** Scout = **Sonnet** (read-only). Implementer = **Opus, high
  effort**. Reviewer = **Sonnet** (pass `model: "sonnet"` explicitly; the agent
  def still pins opus).
- **Loop:** Implementer → Reviewer → gap list → Implementer → Reviewer → … until
  the review is clean AND all tests are green.
- **Batching:** several tasks touching the SAME files → one INLINE implementer
  pass. Otherwise each goes through its own Implementer → Reviewer loop.
- **Tests — all four, every change, named explicitly in the acceptance
  criteria:** unit, **E2E (Playwright)**, smoke, and a regression test for the
  specific behaviour. Not done until all four exist and pass. If one of the four
  is genuinely unreachable, say so plainly — do not fake it.
- **Unrelated failures:** do not chase a red in files you did not touch. Note it
  with its error text and move on. But "environmental" is a claim needing
  evidence exactly as much as "regression" — reproduce it before saying it.
- **UI/UX:** desktop AND mobile, verified at 375px. Responsive, touch-friendly,
  no desktop-only interactions.
- **Pre-commit:** verify the OpenAPI spec has not drifted; regenerate if it has.
  That gate is CI-only, so a green local run proves nothing about it.

## Agent dispatch recipe

Every brief carries: exact file paths, acceptance criteria, what NOT to touch,
the verify command, an output cap ("final message under 20 lines — counts,
paths, deviations, blockers; no file contents or diffs"), a ban on nested
subagents, and "every line number must come from a file you read this session;
write 'not verified' otherwise".

Give the agent the **measured numbers** where you have them. The #451 phase-2
dispatch succeeded on its third attempt largely because it carried the exact
expected values instead of asking the agent to derive them.

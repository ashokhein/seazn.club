# Competition lifecycle + pass integrity — branch state

**Read this first after any compaction.** Branch `fix/pass-lock-376`,
worktree `/Users/ashokhein/github/wt-pass-376`, forked from `origin/main`
at `ea0ffaf2`. Owner rule for this branch: **no new issues** — questions
get asked and fixed inline.

## What this branch is

Three changes that all sit on the same seam — what happens to a
competition when it stops being live, and what the product may still sell
or count once it has.

- **A. #376** — a competition past the pass line still shows the buy chip,
  and the page it links to still offers a checkout that 410s.
- **B. Mandatory end date** — `ends_on` is optional today, which is the
  only reason the `past_ends_on` lock rarely fires.
- **C. Division slot evasion** — archiving a division frees its quota
  slot, so archive→recreate gives unlimited divisions serially.

## Verified facts (re-confirmed on ea0ffaf2 — do not re-derive)

| Fact | Site |
| --- | --- |
| Buy chip renders when gate is `none` | `apps/web/src/components/competition-pass-entry.tsx` (final `return`) |
| `usePassGateState` checks `passKey` BEFORE `lockReason`, so no-pass+locked → `"none"` | `apps/web/src/components/competition-pass-provider.tsx:228-233` |
| The lock is never even COMPUTED without a pass row | `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx:183` — `lockReason: pass ? passLockReason(...) : null` |
| Same pattern repeated on the upgrade page | `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:220` |
| The `ended` arm is INSIDE `if (input.hasPass)`, so no-pass+locked falls through to `offer` | `apps/web/src/lib/upgrade-page-state.ts:98-100` |
| Checkout refuses with **410**, not 400 | `apps/web/src/app/api/billing/pass-checkout/route.ts:180` |
| `passLockReason`: `archived`/`completed` → `terminal`; `ends_on + grace < today` → `past_ends_on`; **null `ends_on` → never locks** | `apps/web/src/lib/entitlements.ts:176-201` |
| `ends_on` column is nullable | `db/migration/v2-engine/tables/V207__competitions.sql:10` |
| API create takes `ends_on` as `.nullish()`; PATCH as `.nullable()` + `.partial()` | `apps/web/src/server/api-v1/schemas.ts:44,71` |
| Division quota counts only `archived_at is null` — deliberate, "archiving frees the slot (v3/09 §4)" | `apps/web/src/server/usecases/divisions.ts:110-114` |
| `restoreDivision` DOES re-check quota — the restore direction is already closed | `apps/web/src/server/usecases/divisions.ts:359-368` |
| `archiveDivision` guards only on `assertRegistrationClosed` | `apps/web/src/server/usecases/divisions.ts:336` |
| `competitions.max_active` deliberately excludes completed/archived — a CONCURRENCY cap. Not a leak, not in scope. | `apps/web/src/server/usecases/competitions.ts:79-99` |
| `pass.entry.ended.nextEdition` exists in all 4 locales | `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` |

**The issue text is wrong in two places** and the fix must not inherit
them: it says the checkout 400s (it is 410), and it says
`upgrade-page-state.ts` returns `ended` regardless of `hasPass` (the
`hasPass` guard was added by `86168e45`, #327, after #301 wrote that
card). So the "damage is a misleading chip, not a broken flow" mitigation
does not hold — an owner gets a live Buy button that dead-ends.

## Decisions taken (owner-approved, do not re-litigate)

1. **Scope: both surfaces.** Chip suppressed AND `/upgrade` gets its own
   no-pass-locked arm.
2. **Chip copy: next-edition pointer alone**, reusing
   `pass.entry.ended.nextEdition`. No sentence about a pass never bought.
3. **Page: a new `closed` kind** in `upgradePageState`, not a reuse of
   `ended` — the `ended` panel renders rung name, receipt date and ticket
   stub, all three of which would be invented for a never-held pass.
4. **The two lock reasons get different next steps on both surfaces.**
   `past_ends_on` says "update the end date if it is still running" —
   fixing the date makes the pass buyable again, so this arm is
   recoverable. `terminal` gets the next-edition pointer.
5. **The new chip state is editor-gated** (`canBuy`), unlike the `ended`
   card. Its only content is an action link; a lone link shown to someone
   who cannot act is noise.
6. **Division slot: play consumes it.** A division with real play keeps
   its quota slot forever, archived or not. An unplayed division archived
   still frees it, so fixing a misconfigured division stays free.
7. **No cutoff timestamp for #6.** Greenfield, no prod data, so a
   "from now on" comparison buys nothing and is dead complexity.
8. **`ends_on` required on create AND on the API**; the column stays
   nullable and PATCH keeps accepting a change, so the date remains
   changeable. Greenfield means no backfill is owed.

9. **Part D added:** `createDivision`/`restoreDivision` refuse on a
   **terminal** competition (409). `past_ends_on` must NOT block — that
   arm is often a stale date on a competition still being played.
10. **Competition slots are a concurrency cap and stay that way.** A
    completed/archived competition frees its `competitions.max_active`
    slot; community is **10 active comps + 4 divisions/comp**
    (`V319__v17_phase1_reorg.sql:13-14`). Asked and answered — do not
    re-open.

    **The 1-and-2 figure this file carried until Task 6 was wrong.** It
    came from `V270__pricing_v3_matrix.sql:7-8`, which V319 superseded.
    `divisions.per_competition.max` is written by V112, V270, V290, V319
    and V341 in turn: read the LAST migration that writes the row, never
    the first one a grep finds. Task 6's tests initially passed for the
    wrong reason because of this. `seedCommunityCompetition` now pins the
    cap to 2 via `org_entitlement_overrides` so the assertions bite
    regardless of what the matrix says.

Full spec: `docs/superpowers/specs/2026-08-05-competition-lifecycle-pass-integrity-design.md`
Full plan: `docs/superpowers/plans/2026-08-05-competition-lifecycle-pass-integrity.md`
**11 tasks, ordered A → C → D → B → gates.** The plan carries every code
block, verify command and commit message. Read it, not this file, to
implement.

## WHERE WE ARE (update this line as tasks land)

Spec ✅ · Plan ✅

| Task | Lane | State |
| --- | --- | --- |
| 1 — `closed` upgrade state | A | ✅ `951f60ca` + `3dbee0c5`, approved |
| 2 — lock judged from the competition | A | ✅ `62ecb93a`, approved |
| 3 — the chip | A | ✅ `4fd65383`, approved |
| 4 — `/upgrade` ClosedPanel (+ `upgrade-gate`) | A | ✅ `dddc9e5c`, review in flight |
| 5 — e2e + demo seed | A | in flight |
| 6 — V354 + shared results predicate | C | ✅ `29e26998`, approved w/ 1 finding |
| 7 — staff waiver | C | ✅ `198d5315`, approved w/ 2 findings |
| V355 — abandoned-with-outcome (from the T6 review) | C | ✅ `bd10d036` |
| T7 follow-ups — audit visibility + no-op 409 | C | in flight |
| 8 — danger-zone copy, 402 explanation, e2e, seed | C | queued |
| 9 — terminal competition guard (part D) | D | in flight |
| 10 (part B), 11 (gates) | — | after all three branches merge |

**Lane D is a THIRD worktree**: `/Users/ashokhein/github/wt-div-part-d`, branch
`fix/division-part-d`, forked from `fix/division-slot-cd@198d5315` so it
inherits V354 and the waiver. Its own Postgres on **`:54333`**. Merges back
into the C branch; its only overlap with Task 8 is `ui.json`, and the two add
different key prefixes.

## What review caught that the plan did not

Five so far, every one in the "looks green, is wrong" class. Keep reviewing.

1. **An existing test asserted the defect as intent** — in Tasks 1, 2, 3 and 4,
   one per task. A test written against #301/#327 encodes the old behaviour as
   a promise. Rewrite the assertion, keep the still-true half, never delete.
2. **The plan's quota premise was stale** (see the correction above).
3. **`restoreDivision` double-counted itself.** The plan said copy the quota
   predicate verbatim; the row being un-archived is itself an
   archived-with-results row, so it needs `and d.id <> ${id}` or a legitimate
   restore is refused.
4. **`division_has_results` missed abandoned-with-a-verdict.**
   `fixtureStatusFromFold` (`append-event.ts:114-118`) returns `"abandoned"`
   BEFORE it checks `outcome !== null`, so a DLS-awarded or leader-awarded
   match carries a real result under status `abandoned` and refunded its slot.
   Fixed in V355. `outcome is not null` is NOT the test — cricket abandon folds
   to a `no_result` OUTCOME, so the predicate keys on
   `outcome->>'kind' <> 'no_result'`.
5. **An audited action nobody can read.** `logStaffAction` wrote
   `division_slot_waived`, but `ADJUSTMENT_ACTIONS`
   (`admin-adjustments-log.ts:14-24`) does not list it and `adjustmentsForOrg`
   filters on that list, so `/admin/orgs/[id]` never rendered it.

## Standing verification bar for this branch

Set by Tasks 6 and 7 and applied since; a task is not done without it.

- **Per-test mutation sweep.** Back up with `cp`, break exactly one thing,
  confirm exactly the expected test reds, restore, and `cmp` to prove the
  restore. Never `git checkout` to restore.
- **Wide sweep before commit**, not just the scoped suites. This is the only
  reason the `upgrade-gate` breakage from Task 2 was caught rather than
  shipped. Whole-`apps/web` baseline after Task 4: `pass 5660 total 5710
  pending 50 suitesFailed 0`.
- **Probe that tsc actually sees a new file** by injecting a type error — a
  file outside the program typechecks clean by doing nothing.
- **`EXPLAIN` any predicate a partial index is supposed to serve.** V355's
  widened index was confirmed by `BitmapOr` over it with no `Seq Scan`.

## RESOLVED — the wt-div-slot "loss" was transient, nothing was lost

**Corrected.** The section below concluded a bare `git restore` had discarded
8 uncommitted files. That was wrong. The files came back on their own a few
minutes later, contents intact, and both of my edits committed cleanly as
`fe573380` (6/6 green). The working tree was **transiently emptied and
restored** — observed at exactly the wrong instant.

**Mechanism now confirmed, and it was not a stash.** The help-pages agent
running in that worktree reported it unprompted: to measure a "before"
baseline it reverted the tree to HEAD, ran the suite, then restored the
files — verifying the restore with `cmp` as byte-identical. My two files sat
inside that ~4-minute window. So the cause is a **sibling agent's
baseline-by-revert**, not a stash cycle, and the honest risk it creates is
real: had I written during that window, the write WOULD have been lost.

The fix is a brief-level ban, now standard in every dispatch here: an agent
must never run `git checkout -- .`, `git restore .`, `git stash`, or any
tree-wide revert to measure a baseline. Baselines are measured either before
making any edit, or per-file via `git show HEAD:<path>`.

Two lessons that still stand, and one that does not:

- **Still true:** stage or commit your own small edits immediately when
  another agent is writing in the same worktree. Staging alone protects you —
  `git checkout -- .` restores from the *index*, so staged content survives.
- **Still true:** never pop or drop a stash entry here. The stack holds
  foreign entries, the newest based on `79f0ff62` (a commit on `main`)
  carrying a `headroom-ai` dependency in `package.json`/`package-lock.json`.
- **Not true:** that anything was destroyed. Do not go looking for lost work.

Keep the reproduction detail below only as a record of what a mid-cycle
observation looks like — an empty `git status` plus a stash stack whose top
entry predates your branch is NOT proof of a hard revert.

## (superseded) INCIDENT AS FIRST DIAGNOSED — kept for the reasoning trail

While the help-pages agent was running in `/Users/ashokhein/github/wt-div-slot`,
**all 8 uncommitted files in that worktree were reverted to HEAD** — its own
6 help-doc edits and 2 of mine. `HEAD` stayed `0ece5974`; nothing in history
was lost; the main checkout is clean and was never touched.

It was NOT a stash. The stack holds 4 entries, the newest based on `79f0ff62`,
a real historical commit **on `main`** — i.e. a pre-existing foreign stash,
not one created here. `git stash list` before/after would have shown a new
entry based on `0ece5974`; there is none. So the cause was a hard
`git restore .` / `git checkout -- .`.

**Do not pop or drop any stash entry.** `stash@{0}` carries a `headroom-ai`
dependency added to `package.json`/`package-lock.json` and belongs to
somebody else. Popping it is the documented way to leave `package.json`
unmerged and block every commit in the tree.

### My two lost edits — REDO THESE, they were green and mutation-proved

They answer the last review finding on `0ece5974`: the waiver audit row
renders but names no division, because the panel shows only `reason` and the
waiver's detail carries `division_id`/`division_name`/`competition_id`.

1. `apps/web/src/server/usecases/admin-adjustments-log.ts`, in `toEntry`,
   replace the `reason` derivation with:

```ts
  const text = (key: string) =>
    typeof detail[key] === "string" && detail[key] ? (detail[key] as string) : null;
  const reason =
    text("reason") ??
    text("reason_code") ??
    // A slot waiver carries no reason of its own — the fact IS which division
    // it freed. The panel renders only `reason` as its subject column, so
    // without this an auditor sees "Division slot waived / cap" over an em
    // dash: something moved this org's division cap, but not WHICH division,
    // which is precisely the question the audit exists to answer. The name is
    // stamped at waive time rather than joined here, so a later rename or
    // delete cannot rewrite what the auditor is told.
    (row.action === "division_slot_waived" ? (text("division_name") ?? text("division_id")) : null);
```

2. `apps/web/src/server/usecases/__tests__/admin-division-slot-waiver.test.ts`,
   in `"surfaces the waiver in the org's adjustments log"`, after the
   `detail.division_id` assertion, add `expect(entry!.reason).toBe("B");`
   with a comment explaining the panel renders `reason` and nothing else.

Verified before the loss: **6/6 green**, `typecheck` EXIT=0, and mutation —
dropping the `division_slot_waived` arm reds exactly that one test (5/1/6).

### Rule this adds

An agent working in a worktree that already has uncommitted files from
another writer must never run a bare `git restore`/`git checkout --`/
`git stash`. Give every implementer brief the explicit list of paths it owns,
and **commit your own small edits immediately** rather than leaving them in
the tree beside a running agent.

## Part B (Task 10) — measured blast radius, do not re-measure

The plan's Step 5 grep (`api/v1/competitions\|insert into competitions\|createCompetition`)
returns ~200 files and is **useless as a work list**: it matches every
`api/v1/competitions/${id}/...` sub-resource path, which a schema change
cannot break.

Measured on `fix/pass-lock-376`:

- **152 real creation sites across 49 files** — POSTs to the *collection*.
  Find them with the exact-collection pattern, not the prefix:
  `git grep -n "\"/api/v1/competitions\"\|'/api/v1/competitions'\|\`/api/v1/competitions\`" -- apps/web/src apps/web/e2e scripts`
- **43 of the 49 are `apps/web/e2e/*.spec.ts`.** The rest: `helpers.ts`,
  `competition-wizard.tsx`, `key-scopes.test.ts`, `seed-demo.ts`,
  `seed-fifa2026.ts`, `smoke-sports.ts`, `smoke.ts`.
- **`scripts/smoke.ts` is the single densest file.**
- **There is no shared API-path creation helper.** `e2e/helpers.ts` exports
  `createCompetitionViaUi`, which drives the wizard, not the API. Each spec
  POSTs for itself.
- **Direct-SQL seeds do NOT break.** `_seed.ts` and the per-file
  `seedCompetition` helpers insert into `competitions` directly, and decision
  8 keeps the **column** nullable — only the zod schema tightens. Do not
  "fix" them; a required `ends_on` in a raw insert proves nothing.

**The risk this creates:** e2e is verified locally only and never on CI, so a
missed e2e site fails at e2e time rather than in the unit gate. Sweep e2e by
grep count before and after, and require the count to reach zero — do not
rely on a green unit suite to prove Part B is complete.

## Flyway note (local DBs only)

`db:apply` can fail `Migration checksum mismatch for migration version 354`
because V354's header comments were amended after it had been applied. Verify
the live object matches the committed migration byte-for-byte, then
`bash scripts/flyway.sh repair` — history-table only, no schema change. Never
edit an applied migration. A fresh database is unaffected.

## EXECUTION IS SPLIT ACROSS TWO WORKTREES (owner asked for it)

Owner instruction: run disjoint tasks in parallel worktrees.

| Lane | Worktree | Branch | Tasks | Own Postgres |
| --- | --- | --- | --- | --- |
| **A** | `/Users/ashokhein/github/wt-pass-376` | `fix/pass-lock-376` | 1–5 (part A) | `:54331` |
| **C/D** | `/Users/ashokhein/github/wt-div-slot` | `fix/division-slot-cd` | 6–9 (parts C, D) | `:54329` |

Both forked from `origin/main@ea0ffaf2`. Both have `.env.local` and
`.claude/agent-memory` symlinked and `node_modules/@seazn/engine`
resolving inside the worktree.

**Why these two are safe to run at once.** Lane A owns
`upgrade-page-state.ts`, `competition-pass-provider.tsx`, the competition
`layout.tsx`, `competition-pass-entry.tsx`, `upgrade/page.tsx`,
`pass-ladder.ts`, `pass-checkout/route.ts`. Lane C/D owns `divisions.ts`,
`V354`, `admin-divisions.ts`, the admin route, `division-danger-zone.tsx`.
Zero overlap. The only shared files are the four `ui.json` (different key
prefixes — `pass.*`/`upgrade.*` versus `division.*` — so different
alphabetical regions) and `scripts/seed-demo.ts` (one appended block each).

**Part B (Task 10) must NOT join them.** It rewrites every fixture that
creates a competition, including `seed-demo.ts` and the e2e specs both
lanes touch. It runs last, alone, after both branches merge.

**The DB rule that protects the owner's data.** `apps/web/.env.local`
points `DATABASE_URL` at the **live local dev DB on `localhost:5432`**, and
`apps/web/vitest.config.ts` lets a pre-set `process.env` var win over the
file. So every test command in either lane MUST carry its own prefix:

```
DATABASE_URL="postgresql://postgres@127.0.0.1:<54331|54329>/seazn_test" DATABASE_SSL=disable
```

Without it, division create/archive suites run against real dev data. Both
instances were started fresh (v353 + `sync:sports`) and each was proved to
be mine via `show data_directory` — `pg_ctl` can fail with "Address already
in use" while the next `createdb` SUCCEEDS against a foreign server.

If these servers are gone after a restart, rebuild per `seazn-local-env`
§1; `db:apply` alone is not a fresh schema (`sync:sports` too, or
`funnel.test.ts` fails `expected 'generic' to be 'badminton'`).

## Discovered during execution (not in the plan)

- An existing test, `"a lock reason with NO pass row is still the ordinary
  offer"` (`upgrade-page-state.test.ts`), **asserted the defect**. No plan
  step mentions it. Rewritten, not deleted — the true half of its claim
  survives. Expect more of these: a test written against #301/#327 may
  encode the bug as intent.
- `upgrade/page.tsx` branches on `state.kind` with `===` chains at ~13
  sites and **no exhaustive switch**, so adding the `closed` union member
  produced **zero** typecheck errors there. Task 4 gets no compiler help;
  `closed` currently falls through as "none of the above". That file's
  header comment also still says "Six states".

## Ordering rationale (do not resequence)

- **A before B.** Making `ends_on` mandatory puts every competition on a
  path to the pass line; shipping B first would widen A's defect.
- **B last also because** it breaks every fixture that creates a
  competition, and doing that mid-branch makes later failures ambiguous.
- **Tasks 3 and 4 both edit all four `ui.json` files** — never run them
  in parallel.

## Traps that apply to this branch specifically

- `Ticket` on the upgrade page takes
  `state: Exclude<UpgradePageState, {kind:"paid_plan"}>` and its
  else-branch renders `<PassUpgradeButton canBuy={state.canBuy}>`. The
  `closed` kind ALSO carries `canBuy`, so a `closed` state reaching that
  component **typechecks and renders a Buy button** — the exact defect
  this branch removes. That is why `closed` gets its own panel and the
  `Exclude` grows a second member.
- The upgrade page's `columns` array still lists both pass rungs for a
  closed competition unless changed — the comparison table is the page's
  SECOND offer surface.
- Delete's predicate (`status <> 'setup' OR has results`) is
  deliberately BROADER than the slot rule (results only). Do not
  "unify" them into one predicate; they share one function, not one rule.

## Standing constraints for this branch

- Every task ships **four** test kinds: unit, e2e (Playwright), smoke,
  and a regression test that fails without the change.
- Any new/changed user-facing string → all 4 locales (en/es/fr/nl).
  `content/help/**` is the exception (one English tree).
- Both drift gates before commit: `openapi:gen` AND `i18n:gen-keys`, then
  `git status --porcelain` must be empty.
- UI verified at desktop and 375px, no horizontal page scroll.
- Agent topology: **scout (sonnet)** — all read-only exploration;
  **implementer (opus, high effort)** — writes code, full skill access;
  **reviewer (sonnet)** — reviews the diff and reports gaps. Loop
  implementer → reviewer → gap list → implementer until the review is
  clean AND tests are green.
- **Batching rule:** tasks touching the same file set run inline in ONE
  implementer pass (avoids conflicts and redundant context). Disjoint
  file sets go through separate implementer → reviewer loops.
- **Every task ships all four test kinds** — unit, e2e (Playwright),
  smoke, regression — named explicitly in its acceptance criteria. A
  task is not done until all four exist and pass.
- **Unrelated failures:** do not chase failures in files you did not
  touch. Skip, note in the summary, let CI surface them.
- **Pre-commit:** verify the OpenAPI spec has not drifted; regenerate if
  it has. Same for i18n keys.
- Toolchain: **TypeScript 7, Node 26, pnpm** (`pnpm@10.34.5`).
- Skills to actually use (not just cite): all `superpowers`,
  `frontend-design`, `stripe`, `playwright`, `supabase`,
  `typescript-lsp`, `code-review`, `seazn-local-env`.
- **Mindset:** look for gaps, edge cases and weak spots; propose
  improvements rather than only implementing what was asked.
- **No new issues.** Questions get asked and fixed inline, unless fixing
  would widen the blast radius.
- Subagent briefs must be **self-contained** — carry the facts, do not
  make the agent re-read to rediscover them.

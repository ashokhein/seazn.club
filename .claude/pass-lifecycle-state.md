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
    slot; community is 1 active comp + 2 divisions/comp
    (`V270__pricing_v3_matrix.sql:7-8`). Asked and answered — do not
    re-open.

Full spec: `docs/superpowers/specs/2026-08-05-competition-lifecycle-pass-integrity-design.md`
Full plan: `docs/superpowers/plans/2026-08-05-competition-lifecycle-pass-integrity.md`
**11 tasks, ordered A → C → D → B → gates.** The plan carries every code
block, verify command and commit message. Read it, not this file, to
implement.

## WHERE WE ARE (update this line as tasks land)

Spec ✅ committed · Plan ✅ committed · **Task 1 not started.** No
production code has been written on this branch yet — every commit so far
is documentation.

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

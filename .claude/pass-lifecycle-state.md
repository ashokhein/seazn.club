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

## Standing constraints for this branch

- Every task ships **four** test kinds: unit, e2e (Playwright), smoke,
  and a regression test that fails without the change.
- Any new/changed user-facing string → all 4 locales (en/es/fr/nl).
  `content/help/**` is the exception (one English tree).
- Both drift gates before commit: `openapi:gen` AND `i18n:gen-keys`, then
  `git status --porcelain` must be empty.
- UI verified at desktop and 375px, no horizontal page scroll.
- Agent topology: scout (sonnet) reads, implementer (opus, high) writes,
  reviewer (sonnet) reviews; loop until clean. Same-file tasks batch into
  one implementer pass.

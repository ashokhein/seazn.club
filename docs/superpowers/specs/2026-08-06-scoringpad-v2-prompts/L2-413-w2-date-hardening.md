# L2 — #413 (W2): date-constraint hardening — division dates, bounds, hierarchy

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Migration + server + forms session.

Branch `feat/l2-w2-date-hardening` in a fresh worktree. One PR. Issue #413.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part I, WS4). Closes #407 WS4.

**Needs L1 merged first** — file-overlap sequencing on `schemas.ts` /
`registrations.ts`, not a logical dependency.

## RESCOPED — read this before anything else

Two claims in the original issue are **no longer true on `main`** (verified
2026-08-06). Do not start from #413's text:

1. **"`ScheduleConfig.endAt` is never read server-side" is FALSE.** The verified-
   scheduling programme (#399) shipped `applyWindow` (`schedule.ts:608-623`) and
   a derived `horizonMinutes` (`:425-428`), so the auto-scheduler is already
   bounded by the competition window and reports `no_slot` rather than
   overflowing. **The remaining work is to narrow that window from the
   competition to the division** once division dates exist — and to keep the
   placer and the verifier agreeing on the same bound.
2. **The migration is not `V345`.** Last applied is `V355`; the next free number
   is **V356** — verify at execution and renumber if the sequence moved again.

## Why

Nothing constrains competition ⊇ division ⊇ schedule/fixture dates. Exactly two
date validations exist in the whole platform: `opens_at < closes_at`
(`registrations.ts`, re-pin) and the runtime `windowOpen()` gate. **Divisions
have no date columns at all.**

Policy per #407: **block with 422 + a structured `extra.violations[]`** on
shrinking edits. Warn-only would persist an invalid hierarchy; the list lets
forms deep-link the offenders. Null division dates inherit the competition window.

## Scope

1. **Migration `db/migration/deltas/V356__division_dates.sql`** (verify the
   number): nullable `divisions.starts_on` / `ends_on date`. Greenfield — no
   backfill needed. Row-local CHECKs: `starts_on <= ends_on` on competitions and
   divisions; `opens_at < closes_at` and `refund_lock_at <= closes_at` on
   registration_settings. Hierarchy checks need joins → usecase layer only.
   Load `supabase:supabase-postgres-best-practices` first.
2. **Zod superRefines (`schemas.ts`)**: Create/PatchCompetition date order;
   Create/PatchDivision gain `starts_on`/`ends_on` + an order refine;
   PutRegistrationSettings window order + refund-lock-within-window; ScheduleConfig
   `startAt < endAt`, blackouts/sessionWindows `from < to`, startWindows
   `notBefore <= notAfter`. AddFixture/PatchFixture stay format-only (cross-entity
   checks belong in the usecase).
3. **New `server/usecases/date-bounds.ts`**:
   `divisionWindow(tx, divisionId) → {division, competition, effective}`
   (null-coalescing inherit); `assertWithin(label, atIso, bounds)` →
   `HttpError(422, …, "DATE_OUT_OF_RANGE", {violations})`;
   `dateShrinkViolations(tx, scope)` listing offending divisions/fixtures/schedule/
   registration rows for `DATE_RANGE_CONFLICT`.
4. **Usecase wiring**: `competitions.ts` patch (a shrink checks divisions and
   fixtures; clearing to null is allowed); `divisions.ts` create/patch
   (⊆ competition; a shrink checks fixtures/schedule/registration);
   `registrations.ts` putSettings — `closes_at <= effective division start`,
   **exempting all-ladder and americano divisions** (late join is by design →
   warn only); `schedule.ts` — the config window must be ⊆ the **division**
   window, and `applyWindow`/`horizonMinutes` must derive from the division
   window once one exists, falling back to the competition window when it does
   not; `patchFixture`, `stages.ts` `addFixture` and
   `competition-schedule-apply.ts` call `assertWithin` on `scheduled_at`.
5. **Forms**: competition wizard + settings (min/max + violation rendering);
   division builder + division settings (new date inputs bounded by the
   competition); registration settings (`closes_at` max = division start); board
   settings panel + schedule board. Strings in all 4 dictionaries.

## Acceptance criteria

- [ ] Division dates outside the competition window → 422 `DATE_OUT_OF_RANGE`
      with violations naming the bound
- [ ] Competition shrink over an existing fixture → 422 `DATE_RANGE_CONFLICT`
      listing the fixture
- [ ] Auto-schedule with a tight division end produces `warn.no_slot`, never a
      slot past the end — and the **placer and the verifier agree on the same
      number** (assert the count from both sides, one shared function)
- [ ] Registration close-after-division-start rejected; the same config on an
      all-ladder division only warns
- [ ] Null division dates behave as the competition window everywhere
      (`effective` tested directly)
- [ ] CHECKs land and the migration applies against a database that already
      contains violating rows (scan test) — or, if greenfield lets you simply
      require clean data, say so explicitly and drop the `NOT VALID` dance
- [ ] `openapi:gen` + commit (schemas changed); `i18n:gen-keys`; then
      `git status --porcelain` **empty**; i18n ×4 green
- [ ] Form screenshots at desktop **and 375px**, no horizontal scroll
- [ ] Vitest counts from the JSON reporter

### Test types

- **Unit** — each zod refine; `date-bounds` coalescing and shrink listing.
- **DB integration** — one per rule: division outside competition; competition
  shrink vs existing fixture; `addFixture` past division end; tight window →
  `no_slot`; registration close-after-start rejected + the ladder exemption;
  the migration scan.
- **E2E (Playwright)** — set a division date outside its competition in the UI
  and see the violation rendered and deep-linked; desktop + 375px.
- **Smoke** — a competition/division creation path in `smoke.ts` sets dates and
  survives.
- **Regression** — the placer/verifier agreement; the ladder exemption.

## Gotchas

- **`settings.tz` is DISPLAY; `settings.orgTz` is the governing clock.** Same
  object, both strings, one letter apart — the in-scope `tz` is the wrong answer
  and it typechecks. `SchedulePack.tz` **is** the org zone despite the name. The
  engine already has `dayKeyInTz`; a day is a wall-clock day where the org lives,
  and a DST day is 23 or 25 hours long — never arithmetic on 86_400_000.
- **Placer vs verifier is this repo's single most recurring scheduling bug** —
  three times in one session. Extract one shared function and assert the same
  number from both sides.
- A `SlotConfig` is structurally assignable to a `VerifyConfig` with
  `tz`/`hard`/`ruleFixtures` undefined — tsc **cannot** catch a dropped rule.
  Grep the builders.
- `db:apply` is Flyway (incremental migrate). Test against the ephemeral PG on
  :54329 with `DB_SCHEMA` set — unset under-reports. A fresh schema needs
  `db:apply` **and** `sync:sports`.
- A `pg_ctl` that fails "Address already in use" is followed by a `createdb` that
  **succeeds** against another session's server. Confirm `show data_directory`.
- Symmetric fixtures cannot catch first-row-wins bugs in `dateShrinkViolations` —
  parameterise the windows.
- Form min/max is a hint, not a gate. Every rule needs its server-side 422 test.

## Execution

Schemas + usecases + forms interlock → **one inline implementer pass**. No
parallel agents.

**Scout (sonnet) brief:** confirm the next free migration number; re-pin
`applyWindow` / `horizonMinutes` / `toSlotConfig` and every caller; find
`registrations.ts`'s date validations and `windowOpen()`; list the six form
files and their date inputs; find where `orgTz` vs `tz` is read in the schedule
path. file:line table only, under 30 lines, no file contents.

**Implementer (opus, high):** brief carries the RESCOPED section verbatim, the
scout table, the orgTz rule, and the placer/verifier requirement.

**Reviewer (sonnet):** is the horizon derived from the **division** window where
one exists? Do the placer and verifier read one shared function? Is any date
arithmetic done on epoch millis instead of `dayKeyInTz`? Gap list only.

## On close

`_INDEX.md`: L2 → DONE, the migration number actually used, whether the
`NOT VALID` dance was kept or dropped under greenfield rules, and the shared
placer/verifier function's name. Memory + `scripts/agent-memory-snapshot.sh`.

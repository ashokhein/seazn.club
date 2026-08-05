# Session state — #448 lane (written pre-compaction, 2026-08-04)

Ranked list from `.claude/next-session-brief.md` is the plan of record.
Order: **#448 → #463 (person-pair first) → #458 → #462 → #449+#450 (one wave) →
#461 → #467 (owner ruled: last)**. Task list #1-#8 mirrors this.

## Environment (already stood up — do NOT redo)

- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/officials-day-tz`
  branch `fix/officials-day-cap-tz-448`, base `origin/main` @ `4a83de9e`.
- `npm ci` DONE. Verified `readlink -f node_modules/@seazn/engine` resolves
  **inside** the worktree (not main's engine).
- `.env.local` (root + `apps/web`) and `.claude/agent-memory` symlinked.
- Postgres **:54337**, db `seazn_test_448`, `DATABASE_SSL=disable`.
  `data_directory` proved to be ours; `db:apply` + `sync:sports` done (11 sports).
  `DATABASE_URL=postgresql://postgres@127.0.0.1:54337/seazn_test_448`
- Other agents' Postgres instances squat :54329/:54331 — do not borrow one.

## In flight

Implementer agent id **`a8df8a449ce44abcd`** (Opus). Resume with SendMessage.
Scope: the #448 fix, plus a sequenced scope addition (the `displayTz` rename)
sent as a follow-up message. Reviewer (Sonnet, pass `model: "sonnet"`) has NOT
run yet — the loop is Implementer → Reviewer → gaps → … until clean and green.

## #448 — premise re-verified against origin/main by content, holds

- `packages/engine/src/officials/assign.ts:39-41` `basisKey` uses
  `toISOString().slice(0,10)` = **UTC** day. Buckets the hard `maxPerDay` cap
  (`:203-207`), `fairness:"per_day"` (`:212`) **and** the fairness-spread warning
  key (`:281-303` — this third one is not in the issue).
- The `:37-38` comment claims the caller owns zones. No caller passes one:
  `OfficialFixture` (`types.ts:7-17`) and `AssignPolicy` (`:41-50`) are tz-free.
- `apps/web/.../officials.ts:320-331` builds the engine fixtures with no tz;
  `venue_tz` is loaded only at `:568` for **emails**, never for the engine.
- Fork inside ONE function, on the SAME `start_at` field, in
  `officials-ai.ts` `refereeOfficialsPlan`: `:501-503` `onBlackout` slices the
  division-offset string → **local** day; `:570` `toISOString()` → **UTC** day.

## Decisions (owner-approved — do not re-open)

1. **Governing zone = `orgTz`**, never `settings.tz`. See
   `reference_settings_tz_vs_orgtz_trap` in memory. Owner picked this.
2. **Blackout `:503` reconciles to the same day key** (owner picked "one day key
   everywhere"). Otherwise fixing `:570` alone creates a NEW fork in the same
   function. Only changes behaviour where a division overrides
   `schedule_settings.tz`; identical when division tz == org tz.
3. **`tz` goes on `AssignInput`, NOT `AssignPolicy`.** `AssignPolicy` is the wire
   schema (`officials.ts:360-364`) — putting it there drifts OpenAPI and lets a
   client choose the zone.
4. **`tz` is REQUIRED, not optional.** Deliberately diverges from the
   `VerifyConfig.tz?` skip-when-absent precedent (`calendar.ts:614-618`):
   skipping silently drops a cap the organiser set. Required turns all four
   builders into compile errors — the only mechanism that catches this bug class.
5. Use the existing `dayKeyInTz` (`packages/engine/src/scheduling/tz.ts:48-55`).
   No new helper, no tz library. Engine's only dep is `z3-solver`.
6. **`displayTz` rename folded into this branch** (owner: "folder into 448"), as
   a SEPARATE COMMIT after the fix is green. Rename
   `ScheduleSettingsOut.tz` → `displayTz` only. Verified internal-only: `orgTz`
   appears nowhere in `openapi/v1.json` / `v1.public.json`. Do NOT rename
   `SchedulePack.tz` / `pack.tz` (that one IS the org zone, documented at
   `schedule-ai.ts:323-330`), `pack.division.tz`, `venue_tz`, the
   `schedule_settings.tz` column, or the `input.tz` PUT field.

## Checked and CLEAN — no eighth bug-class instance

`verifyConfig` at `schedule-ai.ts:1578-1585` passes `tz: pack.tz`, and
`SchedulePack.tz` is the ORG zone per its own doc comment. The main scheduling
lane already keys every day bucket on `orgTz`. Officials was the lone holdout.

## Test surfaces for #448

- engine: `packages/engine/src/officials/assign.test.ts` (`T0 = Date.UTC(2026,6,4,9,0)`
  at `:8`, fixtures at `T0 + slot*30min` at `:19-20` — **nothing crosses a UTC
  midnight**, which is why the suite is blind), `assign.property.test.ts:33-34`,
  `packages/engine/src/testkit/scenarios.ts:321`.
- web: `__tests__/officials-ai-referee.test.ts`, `officials-ai-pack.test.ts`,
  `officials.test.ts`.
- smoke: `scripts/smoke.ts` — existing officials.auto coverage at `:1510` and
  `:9592` is **entitlement-only**, needs a real day-cap case.
- e2e: `apps/web/e2e/` — `officials-directory.spec.ts`,
  `official-marks-reports.spec.ts`, `schedule-panels.spec.ts`,
  `ai-architect.spec.ts`.

## Not yet done

Reviewer pass; commit; PR with `Closes #448` **in the body** (a bare `(#448)` in
the subject does NOT auto-close). Then tasks #2-#7 in order.

# ScoringPad v2 / #407 — session index

**One wave per session.** Read `_RULES.md`, then this file, then the session's
prompt file. This file is the compaction anchor: every ruling, every false
premise, every status change gets written here **as it happens**.

Programme index issue: #411. Design: `../2026-08-03-scoringpad-v2-design.md`.

## Order

Main chain is sequential. The `L` lane is a disjoint file set — run it whenever,
interleaved or in parallel, but `L2` waits on `L1` (shared `schemas.ts`).

| Session | Issue | Prompt file | Depends on | Status |
|---|---|---|---|---|
| S1 | #429 | `S01-429-golden-corpus-policy.md` | — | TODO |
| S2 | #430 | `S02-430-fidelity-tier-4-decision.md` | — | TODO (decision only, no code) |
| S3 | #426 | `S03-426-w4b-mutable-squads.md` | S1 | TODO |
| S4 | #428 | `S04-428-offence-taxonomies.md` | S3 (person-role decision) | TODO |
| S5 | #431 | `S05-431-decisions-register.md` | S3, S4 | TODO |
| S6 | #416 | `S06-416-w5-padspec.md` | S2, S3, S5 | TODO |
| S7 | #427 | `S07-427-pad-vocabulary-i18n.md` | S3, S4, S6 | TODO |
| S8 | #417 | `S08-417-w6-player-stats.md` | S6 | TODO |
| S9 | #418 | `S09-418-w7-career-rollup.md` | S3, S8 | TODO |
| S10 | #419 | `S10-419-w8-chassis-renderer.md` | S6 | TODO |
| S11 | #420 | `S11-420-w9-skins.md` | S7, S10 | TODO |
| S12 | #421 | `S12-421-w10-integration-flag.md` | S11 | TODO |
| S13 | #422 | `S13-422-w11-cutover.md` | S12 | TODO |
| L1 | #412 | `L1-412-w1-eligibility.md` | — | TODO |
| L2 | #413 | `L2-413-w2-date-hardening.md` | L1 | TODO |
| L3 | #414 | `L3-414-w3-formats.md` | — | TODO |

Deferred e2e/smoke debt from the engine-only sessions (S1, S3–S8) is discharged
in **S12** (both entry points, offline) and **S13** (smoke through v2, help tree).
Any session that defers a test type must say so in its PR body.

## Done before this index existed

- **W4 #415** merged 2026-08-03, PR #434, squash `fd452457` — 11 `DOMAIN.md`
  dossiers (8 in `sports/<key>/`, 3 as `setbased/DOMAIN.<sport>.md`), 11 frozen
  golden corpora (`sports/**/**.golden.json`), additive schema extensions,
  person-attribution fields. **No version bumps** — modules stay `1.0.0`.
- **W4a #425** (core time model — durations, elapsed-at-event, expiring
  penalties) merged, PRs #454 + #460, 2026-08-04.

## State of the world, verified against `main` 2026-08-06

Facts the 2026-08-03 prompt file gets wrong. Trust these, not that file.

| Old claim | Truth today |
|---|---|
| W4 #415, W4a #425 open | both closed/merged |
| W2 blocked on #398/#399/#400 | all closed — **W2 unblocked** |
| W1 blocked on #402/#404 | both closed — **W1 unblocked** |
| W2 migration is `V345` | last applied is `V355`; next free is **V356** (re-verify at execution) |
| "`ScheduleConfig.endAt` is never read server-side" | **false** — `applyWindow` (`schedule.ts:608-623`) + derived `horizonMinutes` (`:425-428`) landed with #399. W2 shrinks accordingly |
| minor version bump per touched module | **no bumps** — owner ruling, no prod data, extend at `1.0.0` |
| `padSpec` exists somewhere | absent from `packages/` — W5 is untouched greenfield |
| 11 `DOMAIN.md` files | 8 + 3 `DOMAIN.<sport>.md` inside `setbased/` |

Every line number in any prompt file predates 54 W4 commits. **Scout re-pins
before the implementer touches anything.**

## Rulings carried in (do not re-litigate)

- Pad is rebuilt **greenfield**; supersedes #407 WS2 step 6.
- Programme covers all of #407, "not only the UI layer".
- Stat models **prefer explicit PersonId payload fields**, fall back to
  `personsOf(entrantId)` — hence order W4 → W5 → W6 on the same module files.
- Substrate is complete, do NOT rebuild: hash-chained `score_events`,
  `match_states`, realtime tokens, device links. Legacy V014 `matches` = dead.
- Golden corpora are the only tripwire for schema narrowing — conformance
  generates its own streams and can only ever test the present.
- All 8 #431 singletons were ruled 2026-08-03; S5 executes, it does not re-decide.

## Decision log

Append one line per ruling: date, session, decision, reason. Never delete.

- 2026-08-03 — W4 — no module version bumps; no prod data, extend in place at `1.0.0`.
- 2026-08-03 — W4 — frozen golden corpus lands before any schema work (`55b77714`).
- 2026-08-06 — planning — session order fixed as above; #429 first because five
  correctness rows are deadlocked on the never-re-baseline rule.
- _(append below)_

## Open questions for the owner

- _(none — append as they arise; ask in-session, never file an issue)_

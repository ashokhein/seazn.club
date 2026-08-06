-- V355 — an ABANDONED fixture that still produced a verdict is a result.
--
-- V354 made `division_has_results` the single definition of "this division has
-- recorded results", read by the `divisions.per_competition.max` quota count,
-- by restoreDivision and by deleteDivision's guard. It matched
-- `status in ('decided','finalized','forfeited')` — and that misses a whole
-- class of real results, because of the ORDER of two lines in the fold:
--
--   fixtureStatusFromFold (apps/web/src/server/engine-db/append-event.ts):
--     if (has("core.abandon")) return "abandoned";          -- <= wins
--     if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
--
-- Abandon short-circuits BEFORE the outcome is consulted. So a match that was
-- abandoned yet still produced a verdict — a DLS-awarded cricket result, a
-- leader-awarded football result — writes a genuine `fixtures.outcome` while
-- its status stays `abandoned`. Under V354 those divisions read as "no
-- results", so archiving one refunded the quota slot: create → play (in the
-- rain) → archive → create again, unlimited. Exactly the evasion V354 exists
-- to close. (Pre-existing in deleteDivision's old inline guard too, so this is
-- not a V354 regression — but V354 baked it into the shared predicate.)
--
-- DO NOT "simplify" the new arm to `outcome is not null`. A cricket abandon
-- folds to a **no_result OUTCOME** (see the comment at append-event.ts:113) —
-- the outcome column is non-null and the verdict is "nothing happened". Keying
-- on non-null alone would start charging a paid slot for a rained-off match,
-- the opposite unfairness. MatchOutcome (packages/engine/src/core/types.ts) is
-- a discriminated union on `kind`: win | draw | tie | no_result | award. A win,
-- an award, a draw and a tie are all real verdicts; only `no_result` is not.
--
-- Everything else about V354 is unchanged and deliberate: STABLE not IMMUTABLE
-- (it reads a table), SECURITY INVOKER so RLS on `fixtures` applies to the
-- caller, and still NARROWER than delete's `status <> 'setup' or decided > 0` —
-- publishing a division is a mistake, not usage.
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and (f.status in ('decided', 'finalized', 'forfeited')
              or (f.status = 'abandoned'
                  and f.outcome is not null
                  and f.outcome->>'kind' <> 'no_result')))
  $$;

-- The index must stay USABLE by the widened predicate. A partial index whose
-- WHERE no longer covers the queried rows is silently ignored, and this is
-- evaluated per archived division on every division create — the regression
-- would be a sequential scan over `fixtures`, not a wrong answer, so nothing
-- would fail. Widen the status list to include 'abandoned'; the outcome test
-- stays out of the index predicate so the planner only has to prove the
-- status implication. Exactly one index survives.
drop index if exists fixtures_division_results_idx;
create index if not exists fixtures_division_results_idx
  on fixtures (division_id)
  where status in ('decided', 'finalized', 'forfeited', 'abandoned');

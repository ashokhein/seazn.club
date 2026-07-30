-- Token-weighted AI credit rungs — calibration pass.
--
-- Design: docs/superpowers/specs/2026-07-28-ai-credit-token-weight-design.md §4.
-- Code:   apps/web/src/lib/ai-rung.ts (the constants this query exists to set).
--
-- WHY THIS FILE EXISTS
-- The predictor's thresholds (AI_RUNG_S1 / S2), its weights, and the est-token
-- anchors shipped UNCALIBRATED — chosen by inspection, not from data. The hard
-- token budget is enforced regardless, so a threshold set too low shows up as
-- runs cut short. Run this against production `competition_events` and set the
-- constants from what it reports.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ai-rung-calibration.sql
-- Read-only. Safe on prod. Set the search_path first if your role does not
-- already resolve to the app schema:
--   SET search_path TO seazn_club;
--
-- HOW TO READ IT
-- Section 1 buckets real runs by pack size and reports the p50/p90 of the
-- generation tokens they actually spent. Pick S1 so that p90 of everything at
-- or below it fits inside rung 1's budget (32K by default), and S2 likewise for
-- rung 2's (64K). Section 2 shows how the CURRENT constants would have priced
-- the same history — the "would have been cut short" column is the number that
-- matters. Section 3 reports what actually happened once this shipped.
--
-- Recalibration is: rerun this, edit the constants in ai-rung.ts (or set the
-- AI_RUNG_* env overrides for an immediate change), redeploy.

\echo ''
\echo '=== 1. Observed generation tokens by pack size ==================='
\echo '   Set S1 where p90 first exceeds rung 1'\''s budget (default 32,000),'
\echo '   and S2 where p90 first exceeds rung 2'\''s (default 64,000).'
\echo ''

with runs as (
  select
    (payload ->> 'pack_units')::int                     as pack_units,
    (payload -> 'usage' ->> 'output_tokens')::int       as output_tokens,
    (payload ->> 'cost_usd')::numeric                   as cost_usd,
    type
  from competition_events
  where type in ('schedule.ai_generated', 'schedule.ai_officials_generated')
    and payload ? 'pack_units'
    and payload -> 'usage' ? 'output_tokens'
)
select
  case
    when pack_units <=  25 then '  0- 25'
    when pack_units <=  50 then ' 26- 50'
    when pack_units <= 100 then ' 51-100'
    when pack_units <= 150 then '101-150'
    when pack_units <= 200 then '151-200'
    when pack_units <= 300 then '201-300'
    when pack_units <= 400 then '301-400'
    else                        '   400+'
  end                                                                  as pack_bucket,
  type                                                                 as phase,
  count(*)                                                             as runs,
  round(avg(pack_units))                                               as avg_units,
  percentile_disc(0.5) within group (order by output_tokens)           as p50_output_tokens,
  percentile_disc(0.9) within group (order by output_tokens)           as p90_output_tokens,
  max(output_tokens)                                                   as max_output_tokens,
  round(avg(cost_usd)::numeric, 4)                                     as avg_cost_usd
from runs
group by pack_bucket, phase
order by phase, pack_bucket;

\echo ''
\echo '=== 2. How the CURRENT constants would have priced that history =='
\echo '   `would_exceed_budget` is the count this pricing would have cut'
\echo '   short. Anything above a few percent means the rung is too cheap'
\echo '   for its bucket — raise the budget or lower the threshold.'
\echo ''

-- Keep these four literals in sync with ai-rung.ts (schedulingRungWeights /
-- TOKEN budgets). They are repeated here, not read, because this query runs in
-- psql against prod with no access to the app's env.
with const as (
  select
    0.5::numeric   as entrant_weight,
    2.0::numeric   as court_weight,
    60::numeric    as s1,
    200::numeric   as s2,
    32000::int     as budget_1,
    64000::int     as budget_2,
    128000::int    as budget_3
),
runs as (
  select
    (payload ->> 'pack_units')::int               as pack_units,
    (payload -> 'usage' ->> 'output_tokens')::int as output_tokens
  from competition_events
  where type = 'schedule.ai_generated'
    and payload ? 'pack_units'
    and payload -> 'usage' ? 'output_tokens'
),
-- NOTE: entrants/courts are not on the historical payload, so this approximates
-- sizeScore by pack_units alone. It therefore UNDER-estimates the score, which
-- makes this section a lower bound on how often the budget would bite.
priced as (
  select
    r.output_tokens,
    case
      when r.pack_units <= c.s1 then 1
      when r.pack_units <= c.s2 then 2
      else 3
    end as rung,
    case
      when r.pack_units <= c.s1 then c.budget_1
      when r.pack_units <= c.s2 then c.budget_2
      else c.budget_3
    end as budget
  from runs r cross join const c
)
select
  rung,
  count(*)                                                             as runs,
  budget,
  percentile_disc(0.9) within group (order by output_tokens)           as p90_output_tokens,
  count(*) filter (where output_tokens > budget)                       as would_exceed_budget,
  round(100.0 * count(*) filter (where output_tokens > budget) / nullif(count(*), 0), 1)
                                                                       as pct_cut_short
from priced
group by rung, budget
order by rung;

\echo ''
\echo '=== 3. What actually happened since rung pricing shipped ========='
\echo '   `stopped_on_budget` is ground truth — it is stamped by the meter'
\echo '   itself, not inferred. `underfunded` is the user picking below the'
\echo '   prediction; the two together separate "we mispriced it" from'
\echo '   "they chose to cheap out".'
\echo ''

select
  type                                                                 as event,
  (payload ->> 'rung')::int                                            as rung,
  count(*)                                                             as runs,
  count(*) filter (where (payload ->> 'stopped_on_budget')::bool)      as stopped_on_budget,
  count(*) filter (where (payload ->> 'underfunded')::bool)            as underfunded,
  count(*) filter (
    where (payload ->> 'stopped_on_budget')::bool
      and not coalesce((payload ->> 'underfunded')::bool, false)
  )                                                                    as cut_short_at_predicted_rung,
  percentile_disc(0.9) within group (order by (payload ->> 'spent_tokens')::int)
                                                                       as p90_spent_tokens
from competition_events
where type in ('schedule.ai_generated', 'schedule.ai_officials_generated', 'schedule.ai_failed')
  and payload ? 'rung'
group by event, rung
order by event, rung;

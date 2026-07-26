-- V334 — the Event Pass end-grace comparison switches from `current_date`
-- (session-TZ calendar date) to the UTC calendar date, matching the TS
-- resolver.
--
-- lib/entitlements.ts's isPassLocked computes the grace boundary as
-- `Date.UTC(now.getUTCFullYear(), getUTCMonth(), getUTCDate())` — i.e. UTC
-- calendar-midnight today. `org_has_feature`'s pass arm instead compared
-- against bare `current_date`, which Postgres evaluates in the SESSION's
-- TimeZone GUC. Production's session TZ is Europe/London, not UTC — during
-- BST (UTC+1) the ~1h window from 23:00 to 00:00 UTC has `current_date` one
-- day AHEAD of the UTC calendar date, so around the grace boundary the two
-- resolvers can disagree on whether a pass is locked (public/embed views via
-- SQL vs the app via TS). UTC is the chosen basis — TS already computes on it
-- — so SQL moves to match, not the other way round.
--
-- The body is copied FORWARD from V332 (the current definition of
-- org_has_feature, incl. the trialing/trial_end backstop arm). The ONLY
-- change is that one `current_date` becomes
-- `(now() at time zone 'utc')::date` (today's UTC calendar date). Every other
-- arm — override, plan CASE, coalesce order, Event Pass lifecycle lock's
-- terminal-status check, false default — is byte-for-byte V332.
--
-- Signature, security-definer and the pinned `search_path = <defaultSchema>,
-- pg_temp` (pg_temp LAST so no session can shadow a table inside this definer
-- function) are unchanged. Replacing the function body carries
-- public_competitions_v / public_entrants_v / public_discovery_v unchanged —
-- they call the FUNCTION, so no view is reissued here.
--
-- apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts holds the two
-- resolvers in step; its TZ-divergence case forces a non-UTC session TZ (via
-- a transaction-scoped `set local time zone`) to prove the two agree
-- regardless of the DB session's TimeZone GUC.

create or replace function org_has_feature(
  p_org_id uuid,
  p_feature_key text,
  p_competition_id uuid
) returns boolean
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
    with plan as (
      select case
        -- MODERATION, not billing (mirrors entitlements.ts): a suspended ORG
        -- resolves community whatever its group pays for, scoped to that one org
        -- so a moderator cannot degrade siblings that merely share a payer.
        when o.status = 'suspended' then 'community'
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('trialing', 'active', 'past_due'))
             then 'community'
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
             then 'community'
        -- Trial-end backstop: a trialing sub whose trial ended over a day ago is a
        -- MISSED transition webhook (Stripe moves trialing→active/past_due/canceled at
        -- trial_end). The resolver stops trusting the stale status, cron-free, the same
        -- way the past_due arm above does. 1-day grace absorbs Stripe's transition lag.
        -- trial_end IS null on a never-trialed sub → guard it so those stay on plan.
        when s.status = 'trialing'
             and s.trial_end is not null
             and s.trial_end <= now() - interval '1 day'
             then 'community'
        -- A CANCELLED subscription does not convey its plan (V313). The
        -- comped_at guard keeps an INDEFINITE staff comp alive; a lapsed comp is
        -- already community via the comped_until arm above.
        when s.status = 'canceled' and s.comped_at is null
             then 'community'
        else coalesce(s.plan_key, 'community')
      end as plan_key
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
      where o.id = p_org_id
    )
    select coalesce(
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key
          and (expires_at is null or expires_at > now())),
      -- Event Pass: community orgs only, competition in scope. A key absent from
      -- the pass matrix falls through to the plan row rather than denying. v17
      -- SPEC-4 §7: the pass stops applying once its competition is archived or
      -- long-ended (mirrors isPassLocked in lib/entitlements.ts). The grace
      -- boundary is the UTC calendar date (V334), matching isPassLocked's
      -- Date.UTC(getUTC*) — NOT the session-TZ `current_date`.
      (select pe.bool_value
         from competition_passes cp
         join competitions c on c.id = cp.competition_id
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and (select plan_key from plan) = 'community'
          and not (c.status in ('archived', 'completed')
                   or (c.ends_on is not null
                       and c.ends_on + interval '7 days' < (now() at time zone 'utc')::date))),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

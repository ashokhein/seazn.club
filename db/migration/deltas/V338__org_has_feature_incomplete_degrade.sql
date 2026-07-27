-- V338 — org_has_feature gains the 'incomplete' degrade arm that
-- lib/entitlements.ts's orgPlanKey has carried since #206/#223-B, closing
-- v17 gap #287's SQL sibling (#288).
--
-- A subscription whose FIRST invoice never succeeded (an abandoned 3DS
-- challenge, a declined card at the sheet) lands `status = 'incomplete'` —
-- still a LIVE Stripe status (LIVE_SUBSCRIPTION_STATUSES), so a second
-- checkout is blocked, but it must convey NO plan: the org has paid
-- nothing. TS has resolved this to 'community' since #206/#223-B
-- (entitlements.ts's orgPlanKey). The SQL resolver never got the arm, so
-- it fell through to `coalesce(s.plan_key, 'community')` — Pro, on every
-- public/embed surface the SQL function serves, for up to ~23h until
-- Stripe auto-expires the subscription. Placed at the SAME position in
-- the CASE as the TS version: after the trial_end backstop, before the
-- cancelled-subscription arm (a subscription cannot be both).
--
-- Audit note (#288 "audit ALL Stripe sub statuses in one pass"): Stripe's
-- other two "never really paid" statuses — `unpaid` and
-- `incomplete_expired` — do NOT need their own arms here, in SQL or in
-- TS. STATUS_MAP (lib/billing.ts, via syncSubscriptionForGroup — the one
-- writer of STRIPE-SOURCED status) collapses them at write time —
-- `unpaid` becomes our `past_due` (so it takes the existing 14-day
-- dunning-grace arm, the same as any other renewal failure) and
-- `incomplete_expired` becomes our `canceled` (so it takes the existing
-- immediate canceled-arm, no grace). STATUS_MAP is not the column's only
-- writer — but it is the only one that TRANSLATES a Stripe status, and
-- no other writer can invent one. Every other writer either stamps one
-- of OUR OWN literals (`active`, `trialing`, `past_due`, `canceled` —
-- org creation in lib/auth.ts, the staff comp/extend-trial tools in
-- server/usecases/admin-plan.ts, the webhook handlers in
-- server/usecases/billing-events.ts, the group cancel/downgrade paths in
-- lib/billing.ts) or writes back a value it just read off the row (the
-- comp/trial rollbacks, and cancelGroupIfEmpty's Stripe-cancel rollback
-- in server/usecases/billing-groups.ts). So neither literal string can
-- ever reach this function's `s.status` column. Proven in
-- apps/web/src/lib/__tests__/billing-grace-anchor.test.ts ("#288 audit"
-- cases) and the suspended-org parity case this migration ships
-- alongside (apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts).
--
-- The body is copied FORWARD from V334 (the current definition). The
-- ONLY change is the new `when s.status = 'incomplete' then 'community'`
-- arm. Every other arm — suspended org, comped_until lapse, past_due
-- grace, trial_end backstop, cancelled-without-comp, the UTC pass-grace
-- boundary, the override/pass/plan coalesce chain, the false default —
-- is byte-for-byte V334.
--
-- Signature, security-definer and the pinned
-- `search_path = <defaultSchema>, pg_temp` are unchanged.
-- Replacing the function body carries public_competitions_v /
-- public_entrants_v / public_discovery_v unchanged — they call the
-- FUNCTION, so no view is reissued here.

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
        -- v17 #287/#288: a never-paid first invoice conveys NO plan (mirrors
        -- entitlements.ts's orgPlanKey — the arm this migration adds). Must NOT
        -- inherit the past_due grace above, which is for a renewal that failed on
        -- a subscription that WAS active; 'incomplete' never was.
        when s.status = 'incomplete' then 'community'
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

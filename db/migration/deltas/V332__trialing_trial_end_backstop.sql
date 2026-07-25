-- V332 — a subscription stuck at `trialing` past its trial_end stops granting
-- free Pro (cron-free read-time backstop).
--
-- The resolver gates on subscription STATUS only and never reads `trial_end`.
-- `trialing` is a live status, so a trialing sub resolves to its full paid
-- plan. Stripe moves trialing -> active/past_due/canceled at trial_end via a
-- webhook; if that webhook is missed AND nothing re-syncs the row (only the
-- billing page's needsRenewalResync does), the row stays `trialing` and grants
-- free Pro indefinitely.
--
-- The fix is COMPUTE-AT-READ, mirroring the existing past_due grace arm just
-- above it: a trialing sub whose trial_end is more than a day past degrades to
-- community. No column write, no cron, no scheduler — the subscriptions row is
-- never mutated. 1-day grace absorbs Stripe's own transition lag. A null
-- trial_end (never-trialed row) is guarded so it never degrades. This mirrors
-- lib/entitlements.ts's orgPlanKey, and
-- apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts holds the two in
-- step — change one and that suite fails.
--
-- The body is copied FORWARD from V328 (the current definition of
-- org_has_feature). The ONLY change is the new trial-end arm inserted
-- immediately after the past_due arm. Every other arm — override, plan CASE,
-- coalesce order, Event Pass lifecycle lock, false default — is byte-for-byte
-- V328.
--
-- Signature, security-definer and the pinned `search_path = <defaultSchema>,
-- pg_temp` (pg_temp LAST so no session can shadow a table inside this definer
-- function) are unchanged from V328. Replacing the function body carries
-- public_competitions_v / public_entrants_v / public_discovery_v unchanged —
-- they call the FUNCTION, so no view is reissued here.

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
      -- long-ended (mirrors isPassLocked in lib/entitlements.ts).
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
                       and c.ends_on + interval '7 days' < current_date))),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

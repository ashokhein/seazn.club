-- V344 — an Event Pass applies under ANY plan, and only ever grants.
--
-- v17 gap #327/#337. V338's pass arm carried `and (select plan_key from plan) =
-- 'community'`, on a premise that was true when it was written: Pro's matrix was
-- a strict superset of the pass, so under a paid plan the pass could only be
-- moot. The L rung (#294) ended that. `entrants.per_division.max` is 256 on Pro
-- and UNLIMITED on event_pass_l, so the two offers no longer contain each other,
-- and the community gate had two consequences:
--
--   * #337 — an L holder who then subscribed to Pro silently lost unlimited
--     entrants on the competition they had already paid to unlock. A PAID action
--     that took something away, with nothing anywhere saying so.
--   * #327 — a Pro organiser with one division over 256 entrants had no
--     self-serve path at all: the checkout refused the sale on the same premise.
--
-- TWO changes here, and the second is what makes the first safe:
--
--  1. The community gate is gone: the pass arm is consulted whatever the plan.
--  2. The arm now only answers when the pass says TRUE (`and pe.bool_value`).
--     Without it, coalesce would take a pass's `false` ahead of a plan's `true`
--     and a passed competition would LOSE Pro-only features — the same
--     replacement-instead-of-overlay bug as #209, arriving from the other side.
--     A pass that says nothing, or says false, now falls through to the plan.
--
-- INT limits are not resolved here (org_has_feature returns a boolean); the
-- better-of-both-axes rule for caps lives in lib/entitlements.ts, pinned to this
-- function by entitlements-sql-parity.
--
-- The body is copied FORWARD from V343; the only changed hunk is the pass arm.
-- Signature, security-definer and the pinned search_path are unchanged, and the
-- public_* views call the function, so no view is reissued.

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
      -- Event Pass: competition in scope, ANY plan (v17 #327 — the community
      -- gate is gone, see this migration's header). A key absent from the pass
      -- matrix falls through to the plan row rather than denying, and so now
      -- does a key the pass answers FALSE: `and pe.bool_value` makes this arm
      -- grant-only, so a pass can never take a Pro feature away. v17 SPEC-4 §7:
      -- the pass stops applying once its competition is archived or long-ended
      -- (mirrors isPassLocked in lib/entitlements.ts). The grace boundary is the
      -- UTC calendar date (V334), matching isPassLocked's Date.UTC(getUTC*) —
      -- NOT the session-TZ `current_date`.
      (select pe.bool_value
         from competition_passes cp
         join competitions c on c.id = cp.competition_id
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and pe.bool_value
          and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date)),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

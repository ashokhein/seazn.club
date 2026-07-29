-- V343 — ONE definition of "this competition's Event Pass still applies".
--
-- The rule (SPEC-4 §7) had three copies: lib/entitlements.ts's passLockReason,
-- V338's pass arm inside org_has_feature, and — implicitly, and WRONGLY — the
-- two enforcement sites in server/usecases/{competitions,entitlement-freeze}.ts,
-- which asked only whether a competition_passes ROW EXISTS.
--
-- That third copy was the leak (#347). Those sites filter on the ACTIVE
-- statuses (draft/published/live), which incidentally covers the rule's
-- terminal arm — an archived or completed competition is excluded anyway — but
-- covers NOTHING of the past_ends_on arm. A competition still marked `live`
-- whose ends_on passed more than the grace ago kept its pass exemption for
-- ever: permanently outside competitions.max_active, permanently immune to
-- freezing, on a pass the resolver had already stopped honouring. Nothing
-- retires a live competition past its end date, so nothing ended it.
--
-- The boundary is the UTC CALENDAR DATE, not session-TZ `current_date` (V334),
-- and the comparison is STRICTLY less: ends_on + grace landing exactly on today
-- is still applying.
--
-- IMMUTABLE is correct here despite `now()` NOT appearing in it: the function
-- takes the comparison date from the caller-supplied ends_on only, and the
-- "today" side is passed in by the caller (org_has_feature is STABLE, which is
-- where the clock read belongs). Callers that pass a literal date therefore get
-- a genuinely immutable answer, which is what lets this be inlined and indexed.

create or replace function pass_applies(
  p_status text,
  p_ends_on date,
  p_today date
) returns boolean
  language sql immutable as $$
    select not (
      p_status in ('archived', 'completed')
      or (p_ends_on is not null and p_ends_on + interval '7 days' < p_today)
    )
  $$;

-- org_has_feature re-issued so the resolver calls the function rather than
-- carrying its own copy of the predicate. The body is copied FORWARD from V338;
-- the ONLY change is the pass arm's `and not (...)` clause becoming
-- `and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date)`.
-- Every other arm is byte-for-byte V338 — including its comments, so the diff
-- against V338 is exactly one hunk. Signature, security-definer and the pinned
-- search_path are unchanged; the public_* views call the FUNCTION, so no view
-- is reissued here.

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
          and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date)),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

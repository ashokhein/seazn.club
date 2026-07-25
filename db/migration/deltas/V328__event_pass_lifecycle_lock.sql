-- V328 — an Event Pass stops applying once its competition is over
-- (v17 SPEC-4 §7, #249).
--
-- Until now the resolver's Pass arm granted a community org the pass matrix on a
-- competition forever, regardless of that competition's lifecycle. So a
-- completed/archived (or long-ended) competition kept its Pass entitlements —
-- the abuse in SPEC-4 §2: buy one pass, rename Year-1 -> Year-2, stay entitled.
--
-- The lock is COMPUTE-AT-READ (SPEC §13.1): no column on competition_passes, no
-- status write-back, no auto-archiving, and the pass ROW is never deleted. The
-- pass sub-select simply joins the competition and drops out when the
-- competition is over. This mirrors lib/entitlements.ts's isPassLocked, and
-- apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts holds the two in
-- step — change one and that suite fails.
--
--   lock(status, ends_on) =
--        status in ('archived', 'completed')                       -- A terminal
--     OR (ends_on is not null and ends_on + interval '7 days' < current_date) -- B
--
-- Terminal is SPEC §7's {completed, archived}, and both are reachable: a finished
-- competition is set to 'completed' (usecases/competitions.ts) and an archived one
-- to 'archived'; the active set is {draft, published, live} (V270). The optional
-- 12-month purchased_at cap (§7.3 / #252) is DEFERRED — not built here.
--
-- The body is copied FORWARD from V314 (the current definition of
-- org_has_feature — V306 introduced it, V313 added the cancelled-subscription
-- arm, V314 reached the subscription through organizations.subscription_id and
-- added the suspended-org arm). The ONLY change is the two extra lines on the
-- Event Pass sub-select: a join to competitions and the `not (...)` lifecycle
-- guard. Every other arm — override, plan CASE, coalesce order, false default —
-- is byte-for-byte V314.
--
-- Signature, security-definer and the pinned `search_path = <defaultSchema>,
-- pg_temp` (pg_temp LAST so no session can shadow a table inside this definer
-- function) are unchanged from V314. Replacing the function body carries
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

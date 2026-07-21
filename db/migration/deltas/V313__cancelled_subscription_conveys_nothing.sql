-- V313 — a cancelled subscription must not convey its plan (2026-07-21).
--
-- The resolver degraded on exactly two arms: a lapsed comp, and past_due beyond
-- the 14-day grace. Everything else fell through to `coalesce(s.plan_key,
-- 'community')`. There was no arm for `status = 'canceled'`, so a departed org
-- resolved as community only because the customer.subscription.deleted handler
-- explicitly writes plan_key = 'community'. That made one webhook load-bearing
-- for revenue.
--
-- When it is missed — which is the entire reason the self-heal exists — the row
-- stays past_due; needsRenewalResync fires on any past_due row; the billing page
-- re-syncs from the live subscription; and syncSubscription rewrites plan_key
-- from the subscription's PRICE, which a cancelled subscription still carries.
-- The row lands on status='canceled' with plan_key='pro', and needsRenewalResync
-- returns false for canceled, so nothing ever revisits it. Free Pro, for ever,
-- triggered by the owner opening their own billing page.
--
-- Adding the arm needs a discriminator this table did not have.
-- `comped_until IS NULL` means BOTH "never comped" and "comped indefinitely"
-- (compToPro writes null for a forever-comp, and its staff log literally records
-- "forever"). A cancelled subscription keeps its dead id and its cancelled
-- status by design — admin-plan.ts refuses to write a live-looking status onto a
-- departed row — so `status='canceled' + plan_key='pro' + comped_until IS NULL`
-- is indistinguishable between a legitimate indefinite staff comp and the leak
-- above. Guessing either way breaks something real: degrade and every indefinite
-- comp on a previously-subscribed org is silently revoked; do not degrade and
-- the leak stays open.
--
-- `comped_at` is that discriminator: non-null exactly when this row's paid plan
-- came from a staff comp rather than from Stripe.

alter table subscriptions add column if not exists comped_at timestamptz;

comment on column subscriptions.comped_at is
  'Set when a staff comp granted this row its paid plan; cleared on downgrade. '
  'Distinguishes an indefinite comp (comped_until null, comped_at set) from a '
  'row whose plan_key merely survived a cancellation (both null).';

-- Backfill: a non-null comped_until is unambiguous evidence of a comp. A row
-- with comped_until null cannot be classified from the data — which is the whole
-- problem — and is deliberately left null, i.e. treated as NOT comped. Pre-launch
-- with no customers, so the only rows this misclassifies are seed data.
update subscriptions
   set comped_at = coalesce(status_changed_at, updated_at, now())
 where comped_until is not null
   and comped_at is null;

-- The SQL resolver carries its own copy of the plan CASE and had the identical
-- hole. Public surfaces (public_competitions_v's branding, the realtime reads in
-- server/public-site/data.ts) resolve through this function and not through
-- lib/entitlements.ts, so fixing only the TypeScript side would have left half
-- the app leaking. lib/__tests__/entitlements-sql-parity.test.ts holds the two
-- in step.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text, p_competition_id uuid)
returns boolean
language sql
stable
security definer
set search_path = seazn_club, pg_temp
as $$
    with plan as (
      select case
        -- Mirrors entitlements.ts — a comp past its end date resolves as
        -- community unless a LIVE subscription still owns the plan. coalesce is
        -- load-bearing: a bare NOT IN over a null status yields NULL, not true.
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('trialing', 'active', 'past_due'))
             then 'community'
        -- Mirrors entitlements.ts — dunning gets 14 days from the TRANSITION,
        -- not from the last retry (status_changed_at, coalesced for rows the
        -- V291 backfill never saw).
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
             then 'community'
        -- Mirrors entitlements.ts — a cancelled subscription conveys nothing.
        -- The comped_at guard keeps an INDEFINITE staff comp alive: compOrg
        -- deliberately leaves a departed org's cancelled status in place, so
        -- without it every such comp would be revoked here. A LAPSED comp is
        -- already community via the first arm.
        when s.status = 'canceled' and s.comped_at is null
             then 'community'
        else coalesce(s.plan_key, 'community')
      end as plan_key
      from organizations o
      left join subscriptions s on s.org_id = o.id
      where o.id = p_org_id
    )
    select coalesce(
      -- Override wins, but only while it is alive, and only field by field: a
      -- row that answers the INT question with a null bool_value is NOT a deny,
      -- it is no answer, and falls through.
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key
          and (expires_at is null or expires_at > now())),
      -- Event Pass: community orgs only, competition in scope. A key absent
      -- from the pass matrix falls through to the plan row rather than denying.
      (select pe.bool_value
         from competition_passes cp
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and (select plan_key from plan) = 'community'),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

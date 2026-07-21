-- V310 — billing moves off the org and onto a shared group.
--
-- `subscriptions` was keyed by org_id (V023), so every org carried its own
-- subscription, Stripe customer and card. That made the pricing page's
-- "Organisations you can create: 1 / 3 / ∞" a false promise: orgs two and three
-- were born `community` and each needed its own $19 subscription.
--
-- Here the subscription gains its own identity and becomes the billing GROUP.
-- Orgs point at it. No new table — the row that already carries plan, status,
-- trial and dunning state is the group, so every existing mechanism
-- (comped_until, the 14-day past_due grace, trial_used_at) keeps working
-- untouched; only what it is keyed by changes.
--
-- Stripe Connect is deliberately NOT touched. organizations.stripe_account_id
-- (V021) stays per-org: a Connect account is a legal entity with its own KYC and
-- bank account, and regrouping who pays for the SOFTWARE must have no effect on
-- money in or money out.

-- ---------------------------------------------------------------------------
-- 1. The subscription gains its own identity
-- ---------------------------------------------------------------------------

alter table subscriptions
  add column if not exists id            uuid not null default gen_random_uuid(),
  -- The payer. NOT derived from org membership: a county association may fund
  -- eight member clubs it does not belong to, and after an org ownership
  -- transfer the org's owner and the group's payer are different people by
  -- design. Every billing route gates on THIS column, never on the active org's
  -- owner role.
  add column if not exists owner_user_id uuid,
  -- What Stripe has already been billed for this period. Quantity increments
  -- prorate and charge immediately; decrements make no Stripe call and wait for
  -- renewal, so a removed org frees a paid slot that stays reusable at no charge
  -- until the period ends (up to eleven months on annual). The sync rule is
  --   stripe_quantity = max(active_org_count, quantity_paid)
  -- which is also what stops add/remove cycling from ever producing a refund.
  add column if not exists quantity_paid integer not null default 1;

-- Backfill the payer before the column is made NOT NULL. org_members is the
-- source of truth; created_by is the fallback for any org whose owner row was
-- lost (a user deleted with `on delete set null` leaves created_by null too,
-- hence the final sweep below).
update subscriptions s
   set owner_user_id = coalesce(
     (select m.user_id from org_members m
       where m.org_id = s.org_id and m.role = 'owner'
       order by m.created_at limit 1),
     (select o.created_by from organizations o where o.id = s.org_id))
 where s.owner_user_id is null;

-- An ownerless subscription cannot be billed or managed, so it must not exist.
-- Any row still null here belongs to an org with neither an owner member nor a
-- surviving creator; it is dead billing state and is dropped rather than
-- carried forward with a null payer.
delete from subscriptions where owner_user_id is null;

alter table subscriptions
  alter column owner_user_id set not null;

do $$ begin
  alter table subscriptions
    add constraint subscriptions_owner_fk
    foreign key (owner_user_id) references users(id);
exception when duplicate_object then null; end $$;

-- Repoint the primary key. Nothing FK-references subscriptions (verified: no
-- rows in pg_constraint with confrelid = 'subscriptions'), so this is a local
-- change with no cascade.
alter table subscriptions drop constraint if exists subscriptions_pkey;
alter table subscriptions add primary key (id);

create index if not exists subscriptions_owner_idx on subscriptions(owner_user_id);

-- One Stripe customer belongs to exactly one billing group. This is not
-- cosmetic: the webhook fallback chain resolves a group by
-- `stripe_customer_id` when the metadata stamp is absent (every subscription
-- created before the stamp existed), and without uniqueness that lookup would
-- silently take whichever row came first and could write a plan change to the
-- wrong customer. Partial, because community groups have no Stripe customer at
-- all and many rows are legitimately null.
create unique index if not exists subscriptions_stripe_customer_uniq
  on subscriptions(stripe_customer_id) where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Orgs point at the group they bill through
-- ---------------------------------------------------------------------------

alter table organizations
  add column if not exists subscription_id uuid;

update organizations o
   set subscription_id = s.id
  from subscriptions s
 where s.org_id = o.id and o.subscription_id is null;

-- Every org must bill through exactly one group. An org with no subscription row
-- (possible for rows created before V023's backfill, or if the sweep above
-- dropped an ownerless row) gets a fresh community group of its own, which is
-- precisely the shape createOrgForUser now writes for a brand new org.
with orphan as (
  select o.id as org_id,
         coalesce(
           (select m.user_id from org_members m
             where m.org_id = o.id and m.role = 'owner'
             order by m.created_at limit 1),
           o.created_by) as owner_user_id
    from organizations o
   where o.subscription_id is null
), made as (
  insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
  select owner_user_id, 'community', 'active', 1
    from orphan where owner_user_id is not null
  returning id, owner_user_id
)
update organizations o
   set subscription_id = m.id
  from orphan p join made m on m.owner_user_id = p.owner_user_id
 where o.id = p.org_id and o.subscription_id is null;

do $$ begin
  alter table organizations
    add constraint organizations_subscription_fk
    foreign key (subscription_id) references subscriptions(id);
exception when duplicate_object then null; end $$;

create index if not exists organizations_subscription_idx
  on organizations(subscription_id);

-- org_id has served its purpose: the direction of the relationship is now
-- org -> subscription, and leaving a stale back-pointer would let a group of two
-- claim a single org and silently disagree with organizations.subscription_id.
alter table subscriptions drop column if exists org_id;

-- ---------------------------------------------------------------------------
-- 2b. Retire the 'suspended' subscription status
-- ---------------------------------------------------------------------------
-- The old staff-suspend route wrote `subscriptions.status = 'suspended'` on the
-- org's own row. That is now wrong twice over: the row is shared, so suspending
-- one org would stop billing for every sibling; and suspension is moderation,
-- not billing, so it moves to `organizations.status` where the route now writes
-- it. Nothing in the application writes this status any more.
--
-- Rows the OLD route already wrote must be cleared here, because the new
-- reactivate path no longer knows to. Left alone they are worse than untidy:
-- 'suspended' is not in LIVE_SUBSCRIPTION_STATUSES, so the group reads as
-- non-live for ever — entitlements degrade to community, and
-- `assertCheckoutAllowed` sees no live subscription and would let a customer who
-- is ALREADY PAYING open a second checkout and mint a duplicate Stripe
-- subscription.
--
-- 'active' is the right landing state: these rows were live before a moderator
-- touched them, and any that genuinely lapsed while suspended will be corrected
-- by the next `customer.subscription.updated` webhook, which is authoritative.
update subscriptions
   set status = 'active', status_changed_at = now(), updated_at = now()
 where status = 'suspended';

-- ---------------------------------------------------------------------------
-- 3. The SQL resolver follows the join
-- ---------------------------------------------------------------------------
-- V306 introduced org_has_feature as a security-definer mirror of
-- lib/entitlements.ts, and public_competitions_v / public_entrants_v /
-- public_discovery_v call it. Those views read the FUNCTION, not subscriptions,
-- so replacing the body carries all three unchanged — no view is reissued here.
--
-- Body is copied verbatim from V306 with ONE change: the subscription is reached
-- through organizations.subscription_id instead of subscriptions.org_id.
-- apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts is the tie between
-- this and the TypeScript resolver; both change together or that suite fails.
--
-- The signature, search_path and security properties are unchanged from V306,
-- including pg_temp named LAST so no session can shadow plan_entitlements or
-- subscriptions inside a definer function.

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
        -- Suspension stopped writing subscriptions.status in V310, and this is
        -- what restores its bite.
        when o.status = 'suspended' then 'community'
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('trialing', 'active', 'past_due'))
             then 'community'
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
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

-- ---------------------------------------------------------------------------
-- 4. orgs.max_owned becomes a group cap, and is reseeded
-- ---------------------------------------------------------------------------
-- The quota now counts orgs in the GROUP rather than orgs a user owns, so the
-- numbers are re-pitched around what a group can hold.
--
--   community 1  — unchanged, and load-bearing. Quotas resolve PER ORG, so a
--                  second free org would multiply the free grant: three free
--                  orgs would mean three active competitions, nine members and
--                  three public dashboards for nothing, bypassing the free
--                  tier's only real wall (competitions.max_active = 1).
--   pro       5  — up from 3, reversing V270's tightening. At $19 + 4 x $9 that
--                  is $55/month.
--   pro_plus 10  — down from unlimited. An extra org is HALF the plan base, so
--                  Pro Plus extras are $19 (not $9) and the cap costs
--                  $39 + 9 x $19 = $210/month; an eleventh org becomes an
--                  enterprise conversation rather than a silent reseller.
--
-- The half-price rule exists because V309 made an org slot buy a FEE RATE, not
-- just software. At a flat $9 a club wanting 1% could take a slot in someone's
-- Pro Plus group for $108/year against the $468 the tier itself costs — same
-- rate, 2.5x cheaper — and a reseller could undercut the tier at $20/month while
-- the platform gave up seven points of fee on every entry. Half-price leaves the
-- consolidation discount intact and removes the arbitrage.
--
-- Pro Plus keeps its pull through unlimited SEATS, the 1% fee, AI scheduling,
-- auto officials assignment, write API and priority support.

update plan_entitlements set int_value = 5,  bool_value = null
 where feature_key = 'orgs.max_owned' and plan_key = 'pro';
update plan_entitlements set int_value = 10, bool_value = null
 where feature_key = 'orgs.max_owned' and plan_key = 'pro_plus';

-- V270 raised existing owners to 5 via a per-org override when the pro cap
-- dropped 5 -> 3. Pro is 5 again, so that grandfathering is now a no-op that
-- would only confuse the admin panel and outlive its reason. Only the rows V270
-- itself wrote (int_value = 5) are swept; a hand-written override on this key is
-- left alone.
delete from org_entitlement_overrides
 where feature_key = 'orgs.max_owned' and int_value = 5;

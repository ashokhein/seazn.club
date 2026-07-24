-- V323 — purchasable add-ons: the ADDITIVE cap axis (design/v17-pricing-
-- entitlements/SPEC-2 §3, §11.3).
--
-- Phase 3 sells capacity on top of the plan. Where org_entitlement_overrides
-- REPLACES an int cap, an add-on ADDS to it: effective_cap(org, comp) =
-- plan_base + Σ(delta_each · qty) over active/granted rows whose target matches.
-- Extra seats, size packs, admin-granted capacity all land here; the resolver
-- (lib/entitlements.getLimit) sums them post-cache so a just-purchased or
-- just-canceled seat changes the cap on the very next check.
--
-- Stripe wiring of the SKUs is a LATER task; this migration is the store only.
-- Same text+CHECK style as ai_credit_ledger (V320), no pg enum type.
-- Flyway runs -defaultSchema=seazn_club.

-- wallet_id is TEXT with no foreign key, exactly like ai_credit_ledger: it is
-- coalesce(group_subscription_id, org_id) (§11.1), a subscription id when the
-- org is grouped else the org id, so it cannot reference one table. An add-on
-- is charged to the group PAYER's wallet, so the resolver keys the sum by the
-- org's wallet — buying once lifts every org on the wallet unless target_org_id
-- narrows it to one.
create table if not exists org_addons (
  id                    uuid primary key default gen_random_uuid(),
  wallet_id             text not null,
  -- NULL = group-wide (lifts every member org on the wallet); set = one org.
  target_org_id         text,
  -- NULL = any competition; set = one competition (a comp-scoped size pack).
  target_competition_id text,
  -- The cap this lifts, e.g. 'members.max', 'orgs.max_owned'.
  feature_key           text not null,
  -- +N per unit; multiplied by qty (the Stripe line quantity).
  delta_each            int  not null,
  qty                   int  not null default 1,
  -- NULL when admin-granted (SPEC-3); the Stripe subscription-item id otherwise.
  stripe_item_id        text,
  -- 'active' (Stripe-paid) and 'granted' (admin) both COUNT; 'canceled' does
  -- not — freeze-not-delete, the row stays and the cap drops back to base.
  status                text not null default 'active'
                          check (status in ('active', 'granted', 'canceled')),
  created_at            timestamptz not null default now()
);

-- The resolver's read: sum by (wallet_id, feature_key) over non-canceled rows.
create index if not exists org_addons_wallet_feature_idx
  on org_addons (wallet_id, feature_key) where status <> 'canceled';

comment on table org_addons is
  'Additive entitlement cap add-ons (SPEC-2 §3, §11.3). effective_cap = '
  'plan_base + sum(delta_each * qty) over active/granted rows matching the '
  'org''s wallet + target. wallet_id = coalesce(group_subscription_id, org_id). '
  'status active/granted count, canceled does not (freeze-not-delete).';

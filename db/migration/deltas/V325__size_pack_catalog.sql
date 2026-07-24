-- V325 — the size-pack CATALOG (design/v17-pricing-entitlements/SPEC-2 §3,
-- §11.3; v17 Phase 3 Task 3b — the admin-configurable size-pack add-on).
--
-- Task 3a shipped the recurring extra-seat writer (V324 guards). THIS task
-- adds the ONE-TIME size-pack: a $10 purchase that lifts ONE competition's
-- `entrants.per_division.max` by +32, written into org_addons by the
-- checkout.session.completed webhook. The pack's SHAPE (which cap it lifts,
-- the pack size, its label, whether it is offered, and which Stripe lookup_key
-- carries its price) is admin-configurable, so it lives in a DB table with a
-- code-seeded default rather than a hard-coded constant. The PRICE stays
-- Stripe-owned (stripe-plans.json + stripe:sync, keyed by stripe_lookup_key) —
-- the admin edits the shape, never the price.
--
-- A purchased pack is a FROZEN org_addons row: the webhook snapshots
-- feature_key + delta_each into the org_addons row at grant time (from the
-- session metadata stamped at checkout creation), so a later catalog edit can
-- never retroactively change what an already-bought pack lifts. This table is
-- therefore only consulted at CHECKOUT creation (to stamp the snapshot) and as
-- the webhook's logged fallback — never re-read to recompute a live grant.
--
-- `delta_each > 0` mirrors the org_addons additive-only invariant (V324): a
-- pack that lifts a cap by <= 0 is nonsense the catalog must never carry.
--
-- Unqualified DDL only — Flyway runs -defaultSchema (never write the schema
-- name); same text+CHECK style as V320/V323/V324.

create table size_pack_catalog (
  key               text primary key,
  label             text not null,
  feature_key       text not null,
  delta_each        int  not null check (delta_each > 0),
  stripe_lookup_key text not null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

insert into size_pack_catalog (key, label, feature_key, delta_each, stripe_lookup_key)
values ('size_pack_32', '+32 entrants per division', 'entrants.per_division.max',
        32, 'seazn_size_pack_32');

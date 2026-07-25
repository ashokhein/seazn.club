-- V327 — an idempotency key for ADMIN-granted add-ons (design/v17-pricing-
-- entitlements/SPEC-3-admin-adjustments.md §1 row 3, §2 "no double-grant on
-- double-click").
--
-- SPEC-3 lets staff comp capacity (extra seats / a size pack / extra orgs for a
-- sales deal) by writing an org_addons row with status='granted' and a NULL
-- stripe_item_id. The Stripe-paid writer dedupes redeliveries on
-- org_addons_stripe_item_id_uk (V324) — but that index is PARTIAL
-- (where stripe_item_id is not null), so it does NOT cover admin grants, whose
-- stripe_item_id is always NULL. A double-clicked grant would therefore land
-- twice and double-lift the cap.
--
-- Give the admin grant path its OWN idempotency arbiter: a nullable key column
-- plus a partial unique index (where the key is not null), mirroring V324's
-- shape. grantAddon (server/usecases/admin-addons.ts) writes the key and
-- ON CONFLICT DO NOTHING; a replayed key returns the existing row and writes no
-- second audit row.
--
-- Forward-only + upsert-safe: V323's existing rows (and every Stripe-paid row)
-- carry a NULL key, so the partial index sees none of them and there is no
-- collision on backfill. Unqualified DDL only — Flyway runs
-- -defaultSchema=seazn_club; same text+index style as V324.

alter table org_addons add column if not exists admin_idempotency_key text;

create unique index if not exists org_addons_admin_idem_uk
  on org_addons (admin_idempotency_key) where admin_idempotency_key is not null;

comment on column org_addons.admin_idempotency_key is
  'Idempotency arbiter for admin-granted rows (SPEC-3 §2). NULL on Stripe-paid '
  'rows (those dedupe on stripe_item_id, V324) and on pre-V327 rows. A replayed '
  'grantAddon key conflicts on org_addons_admin_idem_uk and no-ops.';

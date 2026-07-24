-- V324 — org_addons positivity guards + the Stripe-item idempotency key, ahead
-- of the FIRST writer (design/v17-pricing-entitlements/SPEC-2 §3, §11.3; v17
-- Phase 3 Task 3a — the extra-seat recurring add-on).
--
-- V323 landed the store but no guard. Add-ons are ADDITIVE-only: the resolver
-- sums delta_each·qty ON TOP of the plan base, so a negative delta_each would
-- drop the effective cap BELOW plan_base, and qty=0 no-ops a paid seat while
-- still occupying a row. Both are nonsense the writer must never produce, so
-- pin them at the schema before any row lands.
--
-- Cancellation is status='canceled' (freeze-not-delete, V323), which KEEPS
-- qty>0 — so "seats removed / quantity 0" is a status flip, NEVER an
-- insert/update with qty=0. The CHECK below is what makes that contract
-- enforceable rather than merely intended.
--
-- Greenfield: V323 created the table this task's writer is the first to fill,
-- so no existing row can violate these (nothing has written qty/delta_each yet).
--
-- Unqualified DDL only — Flyway runs -defaultSchema=seazn_club (never write the
-- schema name); same text+CHECK style as V320/V323.

alter table org_addons add constraint org_addons_qty_pos   check (qty > 0);
alter table org_addons add constraint org_addons_delta_pos check (delta_each > 0);

-- The webhook (customer.subscription.updated/.created) is the SINGLE writer of
-- Stripe-paid add-on rows and upserts each one keyed on the subscription-item
-- id, so a redelivered event neither duplicates a row nor double-counts the
-- cap: the upsert IS the idempotency. That needs a unique key on stripe_item_id.
-- PARTIAL (where not null): admin-granted rows (SPEC-3) carry a NULL
-- stripe_item_id and must not collide with each other on it.
create unique index if not exists org_addons_stripe_item_id_uk
  on org_addons (stripe_item_id) where stripe_item_id is not null;

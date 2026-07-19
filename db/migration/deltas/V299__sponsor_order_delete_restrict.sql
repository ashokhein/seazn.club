-- Sponsor orders are money records (payments, refunds, disputes — the audit
-- trail chargebacks are answered with). Both parent FKs were ON DELETE
-- CASCADE, so hard-deleting an organization or a package silently destroyed
-- paid orders (live stg incident 2026-07-19: org deleted after a £10 paid +
-- disputed order — record unrecoverable, dispute permanently unmatchable).
-- No app surface hard-deletes orgs/packages (both soft-flip), so the cascade
-- only ever fired from scripts and direct SQL — exactly the paths a DB-level
-- RESTRICT is for. Deleters must now handle money rows consciously first.
alter table sponsor_orders
  drop constraint sponsor_orders_org_id_fkey,
  add constraint sponsor_orders_org_id_fkey
    foreign key (org_id) references organizations(id) on delete restrict;

alter table sponsor_orders
  drop constraint sponsor_orders_package_id_fkey,
  add constraint sponsor_orders_package_id_fkey
    foreign key (package_id) references sponsor_packages(id) on delete restrict;

-- V283 deliberately withheld DELETE on sponsor_orders from app_user: orders
-- are the money audit trail. V299's RESTRICT FKs mean deleteCompetition can
-- no longer rely on the comp→package cascade to sweep abandoned checkouts,
-- so the tenant needs a delete right — but only for rows that never became
-- money. V283's single FOR ALL policy would OR itself into any new delete
-- policy (permissive policies combine), so it is split per command and the
-- delete arm carries the fence: no payment intent, never disputed, still
-- pending. Paid/refunded/disputed rows stay undeletable for tenants.
drop policy sponsor_orders_tenant on sponsor_orders;

create policy sponsor_orders_read on sponsor_orders for select to app_user
  using (org_id = current_org_id());
create policy sponsor_orders_insert on sponsor_orders for insert to app_user
  with check (org_id = current_org_id());
create policy sponsor_orders_write on sponsor_orders for update to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy sponsor_orders_prune on sponsor_orders for delete to app_user
  using (org_id = current_org_id()
         and payment_intent_id is null
         and disputed_at is null
         and status = 'pending');

grant delete on sponsor_orders to app_user;

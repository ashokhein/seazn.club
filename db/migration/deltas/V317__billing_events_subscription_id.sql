-- #223: durable group attribution for the billing-events ledger.
-- invoice.* events carry no subscription_id in Stripe object metadata (Stripe
-- never copies subscription metadata onto invoices), so the admin console
-- could not label a recurring GROUP invoice with its payer + org count. We now
-- resolve the group at ingest (runEvent) and stamp it here.
--
-- FK-less on purpose, matching V259 which dropped billing_events' org FK: the
-- ledger is an append-only audit trail that must survive deletion of the group
-- it references. Null = unresolved, which falls back to org-based attribution.
alter table billing_events
  add column if not exists subscription_id uuid;

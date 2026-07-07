-- Offline payments: while Stripe Connect is disabled, paid registrations are
-- collected by cash or bank transfer. Organisers write the instructions once
-- at org level; they're shown on the registration status page and emailed to
-- the registrant.
alter table organizations
  add column if not exists payment_instructions text;

comment on column organizations.payment_instructions is
  'Free-text cash/bank-transfer instructions shown to registrants of paid divisions while Stripe checkout is disabled.';

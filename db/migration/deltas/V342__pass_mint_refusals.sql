-- V342 — a refused Event Pass mint leaves a DURABLE record (v17 gap #326,
-- review round 1).
--
-- `passSessionRungMatchesPrice` (lib/billing.ts) refuses to mint when the price
-- a checkout session was actually built on disagrees with the rung its metadata
-- names. As first shipped that refusal was a `console.error` plus a staff email
-- and nothing else, which left two holes:
--
--  1. A lost or bounced alert left NO trace at all. The precedent this guard's
--     own comment cites does better: an undetermined pass-credit reversal
--     stamps `pass_credit_redemptions.reversal_undetermined_at` (V337) AND
--     alerts, so the row is the record and the email is only the notification.
--  2. Worse, the checkout route's repeat guard is
--     `select competition_id from competition_passes` — and a refusal writes no
--     pass row. So "This competition already has an Event Pass" never fired,
--     the upgrade page re-rendered its buy button to someone who had just paid,
--     and one desync could charge one customer once per attempt with one staff
--     alert each and zero user-facing signal.
--
-- This table is what the route now consults, and what a future historical sweep
-- has to sweep against.
--
-- Keyed on `stripe_ref` — the PAYMENT INTENT, falling back to the session id for
-- a session that somehow completed without one. That is the same anchor the
-- credit-pack grant uses (`billing-events.ts`: "a session id is still a valid,
-- unique idempotency anchor either way"), and being the primary key it makes a
-- webhook redelivery + reconcile-on-return race a single row rather than a pile.
--
-- NO foreign keys, deliberately, for two reasons. This row is EVIDENCE about
-- money that was taken: it must outlive a deleted competition exactly as
-- pass_credit_redemptions is documented to "survive deletion of the
-- competition_passes row it was earned from". And the ids arrive from Stripe
-- session metadata, so a FK violation would throw inside a webhook handler and
-- turn "one pass was not granted" into an endlessly retried 500.
create table if not exists pass_mint_refusals (
  stripe_ref         text primary key,
  session_id         text not null,
  org_id             uuid not null,
  competition_id     uuid not null,
  -- The rung the metadata CLAIMED. Not constrained to the live rung list: the
  -- point of some refusals is that the claim was not recognisable.
  pass_key           text not null,
  -- 'price_mismatch'  — both price ids were known and they disagreed.
  -- 'line_items'      — the session reported no single line item, so it does not
  --                     match what buildPassCheckoutParams sends at all.
  reason             text not null,
  expected_price_id  text,
  actual_price_id    text,
  refused_at         timestamptz not null default now(),
  -- Set by hand (or by future staff tooling) once a human has refunded the
  -- charge or granted the pass. Until then the checkout route refuses a repeat
  -- purchase for this competition, which is the whole brake.
  resolved_at        timestamptz
);

comment on table pass_mint_refusals is
  'An Event Pass checkout that was PAID but deliberately not minted, because '
  'the price charged disagreed with the rung its metadata named (v17 gap '
  '#326). The buyer holds nothing and their money was taken, so every row here '
  'needs a human: refund the charge, or record the pass at the rung actually '
  'paid for, then stamp resolved_at. Survives deletion of the competition.';

comment on column pass_mint_refusals.stripe_ref is
  'The payment intent, or the session id when the session carried none — the '
  'same anchor the credit-pack grant uses. Primary key, so a webhook '
  'redelivery racing reconcile-on-return writes ONE row.';

-- The route reads by competition, only ever for UNRESOLVED rows, so the index
-- is partial: resolved refusals are history and must not keep blocking a sale.
create index if not exists pass_mint_refusals_open_by_competition
  on pass_mint_refusals (competition_id)
  where resolved_at is null;

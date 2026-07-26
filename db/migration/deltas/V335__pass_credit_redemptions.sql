-- V335 — one Event Pass credit per BILLING GROUP, ever (docs/superpowers/specs/
-- 2026-07-26-pass-credit-redemption-design.md §2).
--
-- `pass-credit.ts` today has NO local record of a credit ever having been
-- issued — the Stripe balance-transaction metadata scan (`alreadyCredited`) is
-- the only trace, and it is scoped to ONE payment intent, not the group. A
-- second Event Pass is a second intent, so nothing stops it minting a second
-- credit: observed live 2026-07-25 as `credited/-5000/2` on one Stripe customer.
--
-- This table is the durable, group-keyed record the scan cannot be: it survives
-- deletion of the `competition_passes` row (which is what makes the later
-- admin-refund path possible at all), and the partial unique index below is the
-- CAP — enforced by the database, not by an application-level check-then-write
-- that a race could slip through.
--
-- DO NOT deploy this migration to an environment with pre-existing pass
-- credits without first running `scripts/backfill-pass-credit-redemptions.ts`
-- (dry-run by default; `--write` to apply). Without it, every group that
-- already redeemed a credit before this table existed has no row here, so
-- the cap below reads clean for them and they can mint one more real credit
-- on a different pass the moment this ships.
create table if not exists pass_credit_redemptions (
  id              uuid primary key default gen_random_uuid(),
  -- The GROUP the cap applies to (not the org — a group shares one Stripe
  -- customer, so a per-org cap would let a group collect £25 per org it adds).
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  -- Which org's pass actually earned the credit (attribution only; the cap key
  -- is subscription_id above).
  org_id          uuid not null references organizations(id) on delete cascade,
  competition_id  uuid not null references competitions(id) on delete cascade,
  payment_intent  text not null unique,
  amount_minor    int  not null,
  currency        text not null,
  redeemed_at     timestamptz not null default now(),
  -- NULL = still live. Set by the Phase 2 admin refund action; the row is kept
  -- (never deleted) as the audit trail of what was reversed and when.
  reversed_at     timestamptz,
  reversed_minor  int
);

-- THE CAP. One un-reversed redemption per group, full stop — a reversed row
-- (staff refunded the pass) frees the group to redeem again, which is the
-- whole reason `reversed_at` exists instead of just deleting the row.
create unique index if not exists pass_credit_redemptions_group_cap
  on pass_credit_redemptions (subscription_id)
  where reversed_at is null;

comment on table pass_credit_redemptions is
  'Durable record of an Event Pass credited toward a subscription (design '
  '2026-07-26 §2). Group-keyed: pass_credit_redemptions_group_cap is a partial '
  'unique index on subscription_id where reversed_at is null, enforcing ONE '
  'live credit per billing group in the database. Survives deletion of the '
  'competition_passes row it was earned from.';

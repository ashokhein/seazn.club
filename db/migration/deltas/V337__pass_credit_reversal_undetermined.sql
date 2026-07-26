-- V337 — undetermined pass-credit reversals keep the group cap HELD (#286,
-- docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md §W1).
--
-- reversePassCreditOnRefund (server/usecases/pass-credit.ts) stamps
-- `reversed_at` on every call, even along the `otherCreditActivitySince()`
-- "unsafe" branch where NOTHING is actually clawed back (the customer keeps
-- the £/$ subscription credit) — which frees V335's partial-index lifetime
-- cap (`pass_credit_redemptions_group_cap`, `where reversed_at is null`) the
-- moment that happens, letting the SAME group redeem a second real Event
-- Pass credit while still holding the first, unreversed one.
--
-- `reversal_undetermined_at` is the new, separate marker for that branch.
-- `reversed_at` keeps being stamped on every call (it still doubles as the
-- "this webhook delivery has been handled" idempotency guard the function's
-- own early-return reads), but `reversal_undetermined_at` is ALSO stamped
-- when `otherCreditActivitySince()` returned unsafe — "I could not prove
-- what to do, so nothing moved". Staff resolution of an undetermined row is
-- phase 2 (deferred, design decisions table).
alter table pass_credit_redemptions
  add column if not exists reversal_undetermined_at timestamptz;

comment on column pass_credit_redemptions.reversal_undetermined_at is
  'Set (#286) when otherCreditActivitySince() could not prove the customer '
  'balance pool was pass-money-only: reversed_at is still stamped (webhook- '
  'replay idempotency guard) but nothing was actually clawed back. NOT NULL '
  'here means pass_credit_redemptions_group_cap must keep treating the row '
  'as live. Staff resolution is phase 2 (deferred).';

-- THE CAP, corrected: V335's predicate (`where reversed_at is null`) is
-- exactly what let this bug free the cap — an undetermined row now has
-- reversed_at SET (still the idempotency stamp) but must still hold the
-- cap, so the predicate widens to also cover it.
drop index if exists pass_credit_redemptions_group_cap;
create unique index if not exists pass_credit_redemptions_group_cap
  on pass_credit_redemptions (subscription_id)
  where reversed_at is null or reversal_undetermined_at is not null;

comment on table pass_credit_redemptions is
  'Durable record of an Event Pass credited toward a subscription (design '
  '2026-07-26 §2). Group-keyed: pass_credit_redemptions_group_cap is a '
  'partial unique index on subscription_id where reversed_at is null OR '
  'reversal_undetermined_at is not null (#286, V337) — an undetermined '
  'reversal still holds the cap even though reversed_at is stamped. '
  'Survives deletion of the competition_passes row it was earned from.';

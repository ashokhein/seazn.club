-- V311 — the transfer offer becomes a row, not a Stripe metadata stamp.
--
-- V310 shipped billing-group transfer with deliberately no schema: the
-- SetupIntent WAS the offer record. That saved a migration and cost more than
-- it saved, three times over.
--
--  1. An offer could not be WITHDRAWN. The intent id was returned once, to the
--     offerer, and stored nowhere — so a page reload left a live claim on the
--     payer's own subscription that they had no way to cancel for seven days.
--
--  2. Single-use was enforced by a `consumed_at` key in Stripe METADATA.
--     Metadata is editable by anyone with Stripe dashboard access, so "an offer
--     can only be used once" was as strong as the dashboard's permissions, not
--     an invariant. A -> B -> A could not be closed at all: the ownership
--     compare-and-swap only covers the same tenure.
--
--  3. Listing offers meant a Stripe round trip per customer on a page render,
--     with a 10s client timeout and no retries (lib/stripe.ts), to draw a panel.
--
-- Stripe stays authoritative for the CARD. This row is authoritative for the
-- OFFER. The split is clean because nothing here duplicates card state.

create table if not exists billing_group_transfers (
  id                uuid primary key default gen_random_uuid(),
  -- CASCADE, because dropEmptyGroup deletes subscription rows outright and an
  -- offer to join a group that no longer exists is not a thing anyone can act
  -- on. A RESTRICT here would turn a routine detach into a failure.
  subscription_id   uuid not null references subscriptions(id) on delete cascade,
  from_user_id      uuid not null references users(id) on delete cascade,
  to_user_id        uuid not null references users(id) on delete cascade,
  -- Null only in the window between claiming the slot and Stripe answering.
  -- An offer with no intent can never be accepted (see the accept predicate in
  -- usecases/billing-groups.ts) and simply expires.
  setup_intent_id   text unique,
  status            text not null default 'pending'
                    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

-- AT MOST ONE live offer per group. Today a payer can quietly stack several
-- offers to different people and whoever confirms a card first takes the group;
-- everyone else discovers it by 409. One outstanding claim at a time is what the
-- UI already implies, and this is what makes it true under concurrency rather
-- than by convention.
create unique index if not exists billing_group_transfers_one_pending
  on billing_group_transfers (subscription_id)
  where status = 'pending';

-- The recipient's inbox: "offers made to me" is now an index lookup instead of
-- listing every Stripe customer whose group the user owns an org in.
create index if not exists billing_group_transfers_to_user
  on billing_group_transfers (to_user_id, status);

-- The payer's view, and the revoke path.
create index if not exists billing_group_transfers_subscription
  on billing_group_transfers (subscription_id, status);

comment on table billing_group_transfers is
  'Pending/settled handovers of a billing group to a new payer. The row is the '
  'offer; the Stripe SetupIntent it names is only the card. Single-use is the '
  'status column plus the partial unique index, not a metadata stamp — Stripe '
  'metadata is editable from the dashboard and cannot hold an invariant.';

comment on column billing_group_transfers.status is
  'pending -> accepted | revoked | expired. Accept is a compare-and-swap from '
  'pending, so two concurrent accepts cannot both win, and an offer that has '
  'been used or withdrawn can never be replayed — including after the group '
  'returns to its original payer, which the ownership CAS alone cannot catch.';

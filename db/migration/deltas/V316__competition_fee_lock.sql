-- V312 — the entry-fee rate locks at the first paid entry.
--
-- `registration.fee_percent` is a plan entitlement (community 8 / pass 5 /
-- pro 2 / pro plus 1, V309), and feePercentFor resolves it LIVE at the moment
-- each entrant pays — only the entry AMOUNT was ever snapshotted, never the
-- platform's cut. That was tolerable when an org's plan only moved when its own
-- owner moved it. Billing groups (V310) broke that: the GROUP PAYER can change
-- the plan for an org they do not own, and either the payer or the org owner can
-- detach it — and every one of those actions silently re-rated every unpaid
-- entry in that org's in-flight competitions. An organiser who set a competition
-- up under Pro Plus (1%) could find their take-home cut to 8% by someone else's
-- action, mid-competition, with entrants already committed.
--
-- The fix: a competition's rate is fixed the moment the first entrant actually
-- pays, and every later entry in that competition is charged the same rate no
-- matter what happens to the plan afterwards. Before any paid entry the rate is
-- still live, so an organiser can correct their plan before sales open and see
-- the new rate apply. The stamp is written at the paid transition from the rate
-- the charge actually used (carried on the registration), not re-resolved, so
-- the locked rate can never disagree with what the first payer was charged.

-- The locked rate for the competition. Null = not yet locked (no paid entry).
-- The application layer reads `competitions.fee_percent ?? feePercentFor(...)`.
alter table competitions
  add column if not exists fee_percent integer;

-- The rate THIS registration's Stripe charge used, snapshotted at checkout
-- creation alongside amount_cents. Null for offline registrations (they incur
-- no platform fee) and for any card registration created before this migration.
-- It exists so the competition can be stamped with the exact rate charged on
-- the first paid entry, even if the plan changed between checkout and webhook.
alter table registrations
  add column if not exists fee_percent integer;

-- Lock competitions that ALREADY have a paid Stripe entry: their first paid
-- entry is in the past, so they must not be exposed to the next plan change
-- either. Locked to the org's CURRENT plan rate — the historical per-charge rate
-- is not recoverable, and the current plan is the rate those competitions are
-- effectively on today.
--
-- Deliberately simpler than feePercentFor: it reads the plan's list rate and
-- ignores per-org overrides and the temporary past_due/comp degradations. Those
-- are rare, and this is a one-time floor for existing data; every rate written
-- from here on comes from the full resolver at checkout time.
update competitions c
   set fee_percent = coalesce(
     (select pe.int_value
        from organizations o
        join subscriptions s on s.id = o.subscription_id
        join plan_entitlements pe
          on pe.plan_key = s.plan_key and pe.feature_key = 'registration.fee_percent'
       where o.id = c.org_id),
     8)
 where c.fee_percent is null
   and exists (
     select 1 from registrations r
       join divisions d on d.id = r.division_id
      where d.competition_id = c.id
        and r.payment_method = 'stripe'
        and r.status in ('paid', 'confirmed'));

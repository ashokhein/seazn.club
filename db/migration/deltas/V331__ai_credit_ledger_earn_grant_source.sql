-- V331 — allow an `earn_grant` source on the AI credit wallet ledger
-- (design/v17-pricing-entitlements/SPEC-5 §2 — the PLG "earn free credits" loop).
--
-- SPEC-5 §2 grows the wallet with free credits for growth milestones: completing
-- onboarding and running a first paid competition (the referral source is
-- deferred — no attribution primitive exists yet). recordEarnGrant (lib/credits.ts)
-- appends a one-time `bucket='pack'` (never-expire) grant to the org's wallet,
-- idempotent per `(reason, ref)` and floored by a lifetime earn cap, so the loop
-- can never mint unbounded free credits.
--
-- Defensive/idempotent: V330 already enumerated `earn_grant` in this CHECK
-- (it was added alongside `pass_grant`), so on an up-to-date schema this migration
-- is a no-op re-assert. It exists to give the earn feature its own migration
-- record and to guarantee the source is valid on any environment whose V330
-- predated the `earn_grant` addition. Same drop-if-exists + re-add shape as
-- V320/V321/V326/V330; Flyway runs -defaultSchema=seazn_club.
alter table ai_credit_ledger
  drop constraint if exists ai_credit_ledger_source_check;

alter table ai_credit_ledger
  add constraint ai_credit_ledger_source_check
    check (source in ('monthly_grant', 'trial_grant', 'pack_purchase',
                      'run_spend', 'refund', 'expiry', 'admin_adjust',
                      'earn_grant', 'pass_grant'));

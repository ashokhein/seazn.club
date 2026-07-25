-- V333 — referral attribution primitive (design/v17-pricing-entitlements/SPEC-5 §2, issue #267).
-- (V332 is taken on main by #269's trialing backstop; this migration was renumbered V332→V333.)
-- referral_code: the org's shareable code (seazn.club/refer/<code>); nullable, generated on demand
--   by getOrCreateReferralCode (lib/referral.ts); partial-unique so many nulls coexist but codes are unique.
-- referred_by_org_id: the org that referred THIS org, stamped once at creation (T2); nullable, immutable
--   by convention. Self-reference is prevented in app code (distinct payer/email guard), not a DB check.
alter table organizations add column if not exists referral_code text;
create unique index if not exists organizations_referral_code_key
  on organizations (referral_code) where referral_code is not null;
alter table organizations add column if not exists referred_by_org_id uuid references organizations (id);

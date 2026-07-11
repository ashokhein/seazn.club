-- v3/07 §3 (PROMPT-36) — Event Pass purchases. One pass upgrades ONE
-- competition for its lifetime (survives Pro downgrade; moot while the org is
-- on Pro). Written by the checkout reconcile/webhook path and read by the
-- entitlement resolver — both on the superuser connection, never as app_user,
-- so like `subscriptions` it is exempt from tenant RLS (scripts/check-rls.ts
-- SUPERUSER_ONLY list).
create table competition_passes (
  competition_id        uuid primary key references competitions(id) on delete cascade,
  org_id                uuid not null references organizations(id) on delete cascade,
  pass_key              text not null default 'event_pass' references plans(key),
  stripe_payment_intent text,
  purchased_at          timestamptz not null default now()
);

create index competition_passes_org_idx on competition_passes(org_id);

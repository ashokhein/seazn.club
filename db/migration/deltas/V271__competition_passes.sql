-- v3/07 §3 (PROMPT-36) — Event Pass purchases. One pass upgrades ONE
-- competition for its lifetime (survives Pro downgrade; moot while the org is
-- on Pro). Written only by the checkout reconcile/webhook path (superuser
-- connection); read by the entitlement resolver (superuser) AND by the freeze
-- selector inside tenant transactions, so app_user gets tenant-scoped SELECT.
create table competition_passes (
  competition_id        uuid primary key references competitions(id) on delete cascade,
  org_id                uuid not null references organizations(id) on delete cascade,
  pass_key              text not null default 'event_pass' references plans(key),
  stripe_payment_intent text,
  purchased_at          timestamptz not null default now()
);

create index competition_passes_org_idx on competition_passes(org_id);

-- RLS — migration-010 direct policy (doc 07 conventions); read-only for the
-- app role, purchases land via the billing superuser path.
alter table competition_passes enable row level security;
alter table competition_passes force  row level security;
drop policy if exists competition_passes_tenant on competition_passes;
create policy competition_passes_tenant on competition_passes for select to app_user
  using (org_id = current_org_id());
grant select on competition_passes to app_user;

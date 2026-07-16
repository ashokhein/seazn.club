-- V283 — Sponsor CRM & monetization (v10 PROMPT-56): sponsorship becomes
-- first-class rows instead of an array inside the branding jsonb blob.
-- The blob is NEVER rewritten here — it stays a read-shim fallback for any
-- scope whose table is empty (resolveSponsors), so rollout has no flag-day.

-- Sponsors: org-wide (competition_id null) or scoped to one competition.
-- logo_path is a storage path/URL resolved at render, same as the blob's
-- `logo` today. click_count backs the tracked /s/[sponsorId] redirect.
create table sponsors (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid references competitions(id) on delete cascade,
  name           text not null,
  url            text,
  logo_path      text,
  tier           text not null default 'partner'
                 check (tier in ('title', 'gold', 'silver', 'partner')),
  display_order  int  not null default 0,
  status         text not null default 'active'
                 check (status in ('active', 'pending', 'inactive')),
  click_count    int  not null default 0,
  created_at     timestamptz not null default now()
);
create index sponsors_org_idx on sponsors(org_id);
create index sponsors_competition_idx on sponsors(competition_id);

alter table sponsors enable row level security;
alter table sponsors force  row level security;
create policy sponsors_tenant on sponsors for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
-- Console CRUD runs as app_user under withTenant; the public renderer and
-- the click redirect read cross-tenant on the privileged connection.
grant select, insert, update, delete on sponsors to app_user;

-- A priced sponsorship offer (what an org SELLS). Buying one creates a
-- sponsor_orders row; payment activates a sponsors row at the package tier.
create table sponsor_packages (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid references competitions(id) on delete cascade,
  name           text not null,
  description    text,
  price_cents    int  not null check (price_cents > 0),
  currency       text not null default 'gbp',
  tier           text not null default 'partner'
                 check (tier in ('title', 'gold', 'silver', 'partner')),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index sponsor_packages_org_idx on sponsor_packages(org_id);

alter table sponsor_packages enable row level security;
alter table sponsor_packages force  row level security;
create policy sponsor_packages_tenant on sponsor_packages for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on sponsor_packages to app_user;

-- One row per checkout attempt, inserted 'pending' BEFORE the PaymentIntent
-- exists (registrations ordering). sponsor_id is set exactly once on
-- activation — it doubles as the webhook-replay guard alongside status.
create table sponsor_orders (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  package_id        uuid not null references sponsor_packages(id) on delete cascade,
  sponsor_name      text not null,
  sponsor_email     text not null,
  payment_intent_id text,
  amount_cents      int  not null,
  currency          text not null,
  status            text not null default 'pending'
                    check (status in ('pending', 'paid', 'failed', 'refunded')),
  sponsor_id        uuid references sponsors(id) on delete set null,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index sponsor_orders_org_idx on sponsor_orders(org_id);
create index sponsor_orders_intent_idx on sponsor_orders(payment_intent_id);

alter table sponsor_orders enable row level security;
alter table sponsor_orders force  row level security;
create policy sponsor_orders_tenant on sponsor_orders for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
-- No delete: orders are the money audit trail. Status flips come from the
-- webhook on the privileged connection; the console reads them.
grant select, insert, update on sponsor_orders to app_user;

-- Entitlements (V269 pattern): tiers + per-competition scoping and paid
-- packages are Pro. The un-tiered partner strip stays free so no org loses
-- its current sponsor line. Event Pass mirrors its entry-fee monetization.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'sponsors.tiers',    false, null),
  ('pro',        'sponsors.tiers',    true,  null),
  ('business',   'sponsors.tiers',    true,  null),
  ('event_pass', 'sponsors.tiers',    true,  null),
  ('community',  'sponsors.monetize', false, null),
  ('pro',        'sponsors.monetize', true,  null),
  ('business',   'sponsors.monetize', true,  null),
  ('event_pass', 'sponsors.monetize', true,  null)
on conflict (plan_key, feature_key) do nothing;

-- BACKFILL (idempotent — the not-exists guard keys on scope, so a re-run
-- against a scope that already has rows inserts nothing; the shim-vs-table
-- test executes this block twice to prove it).
-- backfill:begin
insert into sponsors (org_id, competition_id, name, url, logo_path, tier, display_order)
select o.id, null, s.value->>'name', s.value->>'url', s.value->>'logo',
       'partner', s.ord::int - 1
from organizations o,
     lateral jsonb_array_elements(o.branding->'sponsors') with ordinality as s(value, ord)
where jsonb_typeof(o.branding->'sponsors') = 'array'
  and coalesce(s.value->>'name', '') <> ''
  and not exists (
    select 1 from sponsors sp
    where sp.org_id = o.id and sp.competition_id is null);

insert into sponsors (org_id, competition_id, name, url, logo_path, tier, display_order)
select c.org_id, c.id, s.value->>'name', s.value->>'url', s.value->>'logo',
       'partner', s.ord::int - 1
from competitions c,
     lateral jsonb_array_elements(c.branding->'sponsors') with ordinality as s(value, ord)
where jsonb_typeof(c.branding->'sponsors') = 'array'
  and coalesce(s.value->>'name', '') <> ''
  and not exists (
    select 1 from sponsors sp
    where sp.org_id = c.org_id and sp.competition_id = c.id);
-- backfill:end

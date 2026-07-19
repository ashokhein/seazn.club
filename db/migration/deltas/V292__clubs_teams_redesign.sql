-- =============================================================================
-- W1 §4 (spec 2026-07-18-clubs-teams-redesign): club profile columns,
-- club_contacts, and admin-tunable caps. Additive only.
-- =============================================================================

alter table clubs add column if not exists slug        text;
alter table clubs add column if not exists home_ground text;
alter table clubs add column if not exists website     text;
alter table clubs add column if not exists notes       text;
create unique index if not exists clubs_slug_key on clubs(org_id, slug);

-- FA officer model (spec §4.2); user_id/claimed_at are W3 claim-rail hooks.
create table if not exists club_contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  club_id    uuid not null references clubs(id) on delete cascade,
  role_key   text not null default 'secretary'
             check (role_key in ('secretary','chairman','treasurer','welfare','manager','other')),
  full_name  text not null,
  email      text,
  phone      text,
  is_primary boolean not null default false,
  user_id    uuid references users(id) on delete set null,
  invited_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists club_contacts_club_idx on club_contacts(club_id);
create index if not exists club_contacts_org_idx  on club_contacts(org_id);

-- RLS — migration-010 direct policy (same block V242 used for clubs).
alter table club_contacts enable row level security;
alter table club_contacts force  row level security;
drop policy if exists club_contacts_tenant on club_contacts;
create policy club_contacts_tenant on club_contacts for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on club_contacts to app_user;

-- Caps (spec §4.4). int null = unlimited. All grids/overrides admin-editable.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'clubs.max',       true, 2),
  ('event_pass', 'clubs.max',       true, 2),
  ('pro',        'clubs.max',       true, 20),
  ('pro_plus',   'clubs.max',       true, null),
  ('community',  'teams.max',       true, 2),
  ('event_pass', 'teams.max',       true, 2),
  ('pro',        'teams.max',       true, 40),
  ('pro_plus',   'teams.max',       true, null),
  ('community',  'teams.squad_max', true, 20),
  ('event_pass', 'teams.squad_max', true, 20),
  ('pro',        'teams.squad_max', true, null),
  ('pro_plus',   'teams.squad_max', true, null)
on conflict (plan_key, feature_key) do nothing;

-- Ladder step 3 opens to every plan; clubs.max is the brake (spec decision 3/7).
update plan_entitlements set bool_value = true
 where feature_key = 'clubs.hierarchy' and plan_key in ('community','event_pass');
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p, 'clubs.hierarchy', true, null
from (values ('event_pass'), ('pro_plus')) as v(p)
on conflict (plan_key, feature_key) do nothing;

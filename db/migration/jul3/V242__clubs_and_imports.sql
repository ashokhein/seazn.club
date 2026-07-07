-- =============================================================================
-- Jul3/01 §2 — Club parent entity + bulk-import storage (PROMPT-21).
-- Hierarchy: Club → Team → Entrant(per division), orthogonal to
-- Competition → Division. Org-scoped, persistent across competitions.
-- =============================================================================

create table if not exists clubs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  short_name   text,
  logo_path    text,                 -- Supabase Storage path; inherited by child teams
  colors       jsonb,                -- default kit colours; teams inherit unless overridden
  external_ref text,                 -- FA / affiliation number — upsert key
  created_at   timestamptz not null default now()
);
create index if not exists clubs_org_idx on clubs(org_id);
-- Idempotent upsert key (Jul3/01 §2): prefer external_ref, else folded name.
create unique index if not exists clubs_upsert_key
  on clubs(org_id, coalesce(external_ref, lower(btrim(name))));

alter table teams add column if not exists
  club_id uuid references clubs(id) on delete set null;
create index if not exists teams_club_idx on teams(club_id);

-- Stored import: parse + last plan, re-previewable without re-upload
-- (Jul3/01 §6 GET /imports/{id}).
create table if not exists imports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  filename     text not null,
  config       jsonb not null default '{}',
  rows         jsonb not null,       -- header-mapped ImportRow[]
  plan         jsonb not null,       -- last computed ImportPlan
  status       text not null default 'planned'
               check (status in ('planned','committed')),
  -- doc 08 §3 division-pinned alias: restricts planning to one division
  pin_division_id uuid references divisions(id) on delete cascade,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists imports_org_idx on imports(org_id);

-- RLS — migration-010 direct policy (doc 07 conventions).
do $$
declare tbl text;
begin
  foreach tbl in array array['clubs','imports'] loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force  row level security', tbl);
    execute format('drop policy if exists %I on %I', tbl || '_tenant', tbl);
    execute format(
      'create policy %I on %I for all to app_user
         using (org_id = current_org_id()) with check (org_id = current_org_id())',
      tbl || '_tenant', tbl);
  end loop;
end $$;
grant select, insert, update, delete on clubs, imports to app_user;

-- =============================================================================
-- team_display_v (Jul3/01 §2): effective badge/colours resolved in ONE place —
-- team override wins, else club fallback. App, dashboard and exports all read
-- this view so "upload once per club, all teams show it" holds without copying
-- bytes.
-- =============================================================================
create or replace view team_display_v as
  select t.id  as team_id,
         t.org_id,
         t.name,
         t.short_name,
         t.club_id,
         c.name       as club_name,
         c.short_name as club_short_name,
         coalesce(t.logo_path, c.logo_path) as logo_path,
         coalesce(t.colors,    c.colors)    as colors
  from teams t
  left join clubs c on c.id = t.club_id;
grant select on team_display_v to app_user;

-- Fold the resolver into the doc 07 note-4 public read views: entrants gain an
-- effective team display block (badge + colours + club grouping key).
create or replace view public_entrants_v as
  -- (create-or-replace may only APPEND columns — team_display goes last)
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles')
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles')
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id),
           '[]'::jsonb) as members,
         case when e.team_id is not null then
           (select jsonb_build_object(
              'club_id',    td.club_id,
              'club_name',  td.club_name,
              'logo_path',  td.logo_path,
              'colors',     td.colors)
            from team_display_v td where td.team_id = e.team_id)
         end as team_display
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and e.status in ('registered','confirmed');
grant select on public_entrants_v to app_user;

-- Entitlements (Jul3/01 §7): import.bulk row cap (Community ≤ 20 rows/file),
-- bulk logos + club hierarchy are Pro.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'import.bulk',     true,  20),
  ('pro',       'import.bulk',     true,  null),
  ('business',  'import.bulk',     true,  null),
  ('community', 'logos.bulk',      false, null),
  ('pro',       'logos.bulk',      true,  null),
  ('business',  'logos.bulk',      true,  null),
  ('community', 'clubs.hierarchy', false, null),
  ('pro',       'clubs.hierarchy', true,  null),
  ('business',  'clubs.hierarchy', true,  null)
on conflict (plan_key, feature_key) do nothing;

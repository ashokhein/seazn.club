-- =============================================================================
-- Jul3/02 §2 — Referee & officials assignment (PROMPT-22).
-- officials: org-scoped people (or team-as-referee entrants) with role keys.
-- fixture_officials: the write source; fixtures.officials jsonb stays the
-- denormalized read cache.
-- =============================================================================

create table if not exists officials (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  person_id    uuid references persons(id) on delete set null,   -- null = standalone official
  entrant_id   uuid references entrants(id) on delete set null,  -- set = team-as-referee (27 May)
  display_name text not null,
  role_keys    jsonb not null default '["referee"]',             -- ['referee','judge','scorer']
  home_pool_id uuid references pools(id) on delete set null,     -- constrain to a pool (20 Jun)
  max_per_day  int,                                              -- fairness cap (29 May)
  created_at   timestamptz not null default now()
);
create index if not exists officials_org_idx on officials(org_id);

-- assignment of an official to a fixture in a role (multiple roles per fixture: 25 Dec)
create table if not exists fixture_officials (
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  official_id uuid not null references officials(id) on delete cascade,
  org_id      uuid not null,
  role_key    text not null,                  -- 'referee' | 'judge' | ...
  source      text not null default 'manual' check (source in ('manual','auto')),
  locked      boolean not null default false, -- pinned; auto pass treats as obstacle
  primary key (fixture_id, role_key, official_id)
);
create index if not exists fixture_officials_official_idx on fixture_officials(official_id);

-- org_id trigger for the child table (010 pattern via the generic function)
drop trigger if exists trg_set_org on fixture_officials;
create trigger trg_set_org before insert on fixture_officials
  for each row execute function set_org_from_parent('fixtures', 'fixture_id');

-- RLS — direct policy on both
do $$
declare tbl text;
begin
  foreach tbl in array array['officials','fixture_officials'] loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force  row level security', tbl);
    execute format('drop policy if exists %I on %I', tbl || '_tenant', tbl);
    execute format(
      'create policy %I on %I for all to app_user
         using (org_id = current_org_id()) with check (org_id = current_org_id())',
      tbl || '_tenant', tbl);
  end loop;
end $$;
grant select, insert, update, delete on officials, fixture_officials to app_user;

-- Hide-names toggle (25 Jun): public read strips official names, division-wide.
alter table divisions add column if not exists
  officials_hide_names boolean not null default false;

-- Public fixtures view gains the officials cache, nulled when hidden
-- (doc 07 note 4; create-or-replace may only APPEND columns).
create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq,
         case when d.officials_hide_names or d.status = 'setup'
              then '[]'::jsonb else f.officials end as officials
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
grant select on public_fixtures_v to app_user;

-- Entitlements (Jul3/02 §5): auto-assign + multi-role are Pro; manual
-- single-role assignment is free on every plan.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'officials.auto',        false, null),
  ('pro',       'officials.auto',        true,  null),
  ('business',  'officials.auto',        true,  null),
  ('community', 'officials.roles_multi', false, null),
  ('pro',       'officials.roles_multi', true,  null),
  ('business',  'officials.roles_multi', true,  null)
on conflict (plan_key, feature_key) do nothing;

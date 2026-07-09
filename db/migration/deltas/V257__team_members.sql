-- ---------------------------------------------------------------------------
-- Persistent team squad. A team's standing roster, independent of any
-- competition — managed in the club directory and used to auto-seed an
-- entrant's roster when the team is enrolled into a division. Mirrors
-- entrant_members so seeding is a straight copy.
-- ---------------------------------------------------------------------------
create table if not exists team_members (
  team_id      uuid not null references teams(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  squad_number int,
  default_position_key text,
  is_captain   boolean not null default false,
  roles        jsonb not null default '[]',
  primary key (team_id, person_id)
);
create index if not exists team_members_team_idx on team_members(team_id);

-- org_id denormalized from the parent team (doc 07 note-3), same trigger the
-- rest of the v2 tables use.
drop trigger if exists trg_set_org on team_members;
create trigger trg_set_org before insert on team_members
  for each row execute function set_org_from_parent('teams', 'team_id');

-- RLS — migration-010 direct policy (doc 07 conventions).
alter table team_members enable row level security;
alter table team_members force  row level security;
drop policy if exists team_members_tenant on team_members;
create policy team_members_tenant on team_members for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on team_members to app_user;

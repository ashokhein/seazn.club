create table if not exists entrant_members (
  entrant_id   uuid not null references entrants(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  squad_number int,
  default_position_key text,
  is_captain   boolean not null default false,
  roles        jsonb not null default '[]',
  primary key (entrant_id, person_id)
);

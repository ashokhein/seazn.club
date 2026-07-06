create table if not exists lineups (
  fixture_id   uuid not null references fixtures(id) on delete cascade,
  entrant_id   uuid not null references entrants(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  slot         text not null default 'starting' check (slot in ('starting','bench')),
  position_key text,
  order_no     int,
  roles        jsonb not null default '[]',
  primary key (fixture_id, entrant_id, person_id)
);

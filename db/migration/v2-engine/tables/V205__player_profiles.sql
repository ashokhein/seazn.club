create table if not exists player_profiles (   -- per-sport attributes, sparse
  person_id  uuid not null references persons(id) on delete cascade,
  sport_key  text not null references sports(key),
  attributes jsonb not null default '{}',
  org_id     uuid not null,
  primary key (person_id, sport_key)
);

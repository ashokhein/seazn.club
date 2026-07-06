create table if not exists pools (
  id        uuid primary key default gen_random_uuid(),
  stage_id  uuid not null references stages(id) on delete cascade,
  org_id    uuid not null,
  key       text not null,
  name      text not null
);

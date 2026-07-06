create table if not exists stages (
  id            uuid primary key default gen_random_uuid(),
  division_id   uuid not null references divisions(id) on delete cascade,
  org_id        uuid not null,
  seq           int  not null,
  kind          text not null check (kind in ('league','group','swiss','knockout','double_elim','stepladder')),
  name          text not null,
  config        jsonb not null default '{}',
  qualification jsonb,
  status        text not null default 'pending' check (status in ('pending','active','complete')),
  unique (division_id, seq)
);

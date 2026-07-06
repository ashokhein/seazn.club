create table if not exists billing_events (
  id            text primary key,
  type          text not null,
  org_id        uuid references organizations(id),
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

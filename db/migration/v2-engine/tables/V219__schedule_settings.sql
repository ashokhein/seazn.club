-- Per-division scheduling settings (doc 12 §3, PROMPT-17). config carries
-- startAt, matchMinutes, gapMinutes, courts[], perEntrantMinRest, blackouts[],
-- sessionWindows[]; tz is the venue-local zone (doc 12 §6 — DST boundaries).
create table if not exists schedule_settings (
  division_id uuid primary key references divisions(id) on delete cascade,
  org_id      uuid not null,
  config      jsonb not null default '{}',
  tz          text not null default 'UTC',
  updated_at  timestamptz not null default now()
);

-- =============================================================================
-- Jul3/03 §2 — Schedule undo, versioning & safe destructive ops (PROMPT-23).
-- Undo is ledger navigation, not deletion: inverse events are appended and
-- edit_watermark moves; division_events stays append-only + hash-chained.
-- =============================================================================

alter table divisions add column if not exists
  schedule_locked boolean not null default false;   -- whole-division freeze
alter table divisions add column if not exists
  edit_watermark  bigint;                            -- current undo position (null = head)
-- Scope locks (Jul3/03 §4, two-site safety 22 Jun): [{courts?: [], venues?: [],
-- pool_ids?: []}] — matching fixtures are treated as locked obstacles.
alter table divisions add column if not exists
  locked_scopes jsonb not null default '[]';

-- NOTE (Jul3/03 §2 deviation): the design sketches `fixtures.locked` +
-- `fixtures.schedule_source`; both already exist as `fixtures.schedule_locked`
-- (PROMPT-17 pin, already wired into the solver as an obstacle) and
-- `fixtures.schedule_source` — no new fixture columns needed.

-- named save points an organiser can restore to (16 Jun "go back to version")
create table if not exists division_checkpoints (
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references divisions(id) on delete cascade,
  org_id      uuid not null,
  seq         bigint not null,               -- division_events watermark captured
  label       text not null,                 -- 'before rain reshuffle'
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists division_checkpoints_division_idx
  on division_checkpoints(division_id, created_at desc);

drop trigger if exists trg_set_org on division_checkpoints;
create trigger trg_set_org before insert on division_checkpoints
  for each row execute function set_org_from_parent('divisions', 'division_id');

alter table division_checkpoints enable row level security;
alter table division_checkpoints force  row level security;
drop policy if exists division_checkpoints_tenant on division_checkpoints;
create policy division_checkpoints_tenant on division_checkpoints for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on division_checkpoints to app_user;

-- Entitlements (Jul3/03 §7): undo/redo + confirmed clear are ALL plans
-- (safety is not a paywall); named checkpoints beyond one + scope locking
-- are Pro.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'schedule.versioning', false, null),
  ('pro',       'schedule.versioning', true,  null),
  ('business',  'schedule.versioning', true,  null)
on conflict (plan_key, feature_key) do nothing;

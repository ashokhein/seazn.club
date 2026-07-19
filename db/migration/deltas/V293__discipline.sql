-- =============================================================================
-- V293 — Player discipline & suspensions (SPEC-1 / PROMPT-78).
-- Folds person-attributed card events (already in score_events) into a
-- per-division disciplinary ledger. Read-side projection only: zero engine
-- reducer/replay/golden change (README D2). Drafted as V291; renumbered to
-- V293 (V291 = payments-hardening, V292 = clubs-teams on main) — same lesson as V286 to V290.
-- Tables + RLS mirror V284 (explicit org_id, enable/force RLS, tenant policy,
-- app_user grants); public reads go through the superuser sql connection like
-- publicDivisionStats (no extra policy). Idempotent seed at the tail.
-- =============================================================================

create table discipline_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  division_id  uuid not null unique references divisions(id) on delete cascade,
  enabled      boolean not null default true,
  rules        jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table suspensions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  division_id    uuid not null references divisions(id) on delete cascade,
  person_id      uuid not null references persons(id) on delete cascade,
  entrant_id     uuid references entrants(id) on delete set null,
  status         text not null default 'pending'
                   check (status in ('pending','active','served','waived')),
  source         text not null
                   check (source in ('auto_accumulation','auto_dismissal','manual','report')),
  rule_key       text,          -- which rule fired (accumulation bucket id), null for manual
  bucket         int,           -- Nth accumulation window (5th yellow = 1, 10th = 2)
  reason         text not null, -- human string: "5th yellow card", "violent conduct"
  matches_total  int not null check (matches_total >= 1),
  matches_served int not null default 0,
  trigger_event_ids uuid[],     -- score_events audit trail
  fixture_id     uuid references fixtures(id) on delete set null,
  created_by     uuid,          -- console user (manual), null for auto
  decided_by     uuid,          -- who confirmed/waived
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Idempotency: one auto suspension per rule window per person per division.
create unique index suspensions_auto_once
  on suspensions(division_id, person_id, rule_key, bucket)
  where source in ('auto_accumulation','auto_dismissal');
create index suspensions_person_idx on suspensions(division_id, person_id, status);

-- RLS — mirror V284 (both tables enable + force; tenant policy on org_id;
-- rows are written under withTenant/app_user, so grant the full CRUD set).
alter table discipline_rules enable row level security;
alter table discipline_rules force  row level security;
create policy discipline_rules_tenant on discipline_rules for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on discipline_rules to app_user;

alter table suspensions enable row level security;
alter table suspensions force  row level security;
create policy suspensions_tenant on suspensions for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on suspensions to app_user;

-- Entitlement discipline.enforced (SPEC-1): cards are already Pro (D7), so the
-- accumulation ledger is Pro too. Every plan gets a row — a missing row DENIES
-- (lib/entitlements resolver). Idempotent.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'discipline.enforced', false, null),
  ('event_pass', 'discipline.enforced', false, null),
  ('pro',        'discipline.enforced', true,  null),
  ('pro_plus',   'discipline.enforced', true,  null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

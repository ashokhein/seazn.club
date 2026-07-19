-- =============================================================================
-- V294 — Official marks & match reports (SPEC-3 / PROMPT-80).
-- Two adjacent features on the fixture_officials assignment row: organiser
-- marks (Pro, org-private) and official-filed match reports (free, cross-org).
-- Submitted reports feed SPEC-1 (V293) as *suggested* pending suspensions via a
-- soft, idempotent bridge that ships dark when discipline is absent. Drafted as
-- V294 (V291 payments, V292 clubs, V293 discipline — same lesson as V286 to V290).
--
-- fixture_officials predates single-row identity (composite PK
-- fixture_id/role_key/official_id, no surrogate). The whole SPEC-3 surface and
-- v1 API key on ONE uuid per assignment (fixtureOfficialId), so add a stable
-- surrogate id here and reference it. Additive only: the composite PK and every
-- existing on-conflict target stay intact; existing rows get an id via default.
--
-- Tables + RLS mirror V284/V293 (explicit org_id, enable/force RLS, tenant
-- policy, app_user grants). Marks are written on the tenant rail (organiser),
-- so the app_user gets full CRUD. Reports are written by the official through
-- the superuser connection (the V284 official_availability rail — an official
-- is not an org member); the tenant policy serves organiser-console reads only,
-- so the app_user gets select. Idempotent entitlement seed at the tail.
-- =============================================================================

alter table fixture_officials add column id uuid not null default gen_random_uuid();
alter table fixture_officials add constraint fixture_officials_id_key unique (id);

create table official_marks (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  fixture_official_id uuid not null unique references fixture_officials(id) on delete cascade,
  official_id         uuid not null references officials(id) on delete cascade,
  fixture_id          uuid not null references fixtures(id) on delete cascade,
  mark                int not null check (mark between 1 and 5),
  comment             text,
  created_by          uuid,             -- console user
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index official_marks_official_idx on official_marks(official_id);

create table match_reports (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  fixture_official_id uuid not null unique references fixture_officials(id) on delete cascade,
  official_id         uuid not null references officials(id) on delete cascade,
  fixture_id          uuid not null references fixtures(id) on delete cascade,
  status              text not null default 'draft'
                        check (status in ('draft','submitted')),
  body                text not null default '',
  incidents           jsonb not null default '[]',
  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index match_reports_fixture_idx on match_reports(fixture_id);

-- Report bridge idempotency (SPEC-3): at most one pending suspension per report
-- incident, keyed rule_key = report:<fixture_official_id>, bucket = incident
-- index. V293 suspensions_auto_once excludes source=report, so the report lane
-- needs its own partial unique index.
create unique index suspensions_report_once
  on suspensions(division_id, person_id, rule_key, bucket)
  where source = 'report';

-- RLS.
alter table official_marks enable row level security;
alter table official_marks force  row level security;
create policy official_marks_tenant on official_marks for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on official_marks to app_user;

alter table match_reports enable row level security;
alter table match_reports force  row level security;
create policy match_reports_tenant on match_reports for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on match_reports to app_user;

-- Entitlement officials.marks (SPEC-3): organiser marking is Pro; the
-- officiating portal (reports) stays free on every plan (no gate). A missing
-- row DENIES (lib/entitlements resolver), so every plan gets a row. Idempotent.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'officials.marks', false, null),
  ('event_pass', 'officials.marks', false, null),
  ('pro',        'officials.marks', true,  null),
  ('pro_plus',   'officials.marks', true,  null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

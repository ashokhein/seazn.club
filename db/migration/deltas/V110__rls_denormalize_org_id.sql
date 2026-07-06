-- 010 — RLS: denormalize org_id onto hot child tables
-- =============================================================================
-- schema.sql enables + forces RLS on players/rounds/matches/match_events/
-- audit_log but their policies sub-select into `tournaments` on every row.
-- Denormalize `org_id` onto these tables so each policy is a cheap, indexable
-- `org_id = current_org_id()` comparison. A BEFORE INSERT trigger fills org_id
-- from the parent tournament, so application inserts don't change and the value
-- can never drift from the tournament it belongs to.
-- Idempotent: safe to re-run and safe on both fresh (CI) and populated (prod) DBs.
-- =============================================================================

-- 1. Columns (nullable first so the backfill can run).
alter table players       add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table rounds        add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table matches       add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table match_events  add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table audit_log     add column if not exists org_id uuid references organizations(id) on delete cascade;

-- 2. Backfill from the parent tournament. audit_log.tournament_id is nullable
--    (system rows); those keep org_id null and are only ever written by the
--    superuser connection, which bypasses RLS.
update players       p set org_id = t.org_id from tournaments t where p.tournament_id = t.id and p.org_id is null;
update rounds        r set org_id = t.org_id from tournaments t where r.tournament_id = t.id and r.org_id is null;
update matches       m set org_id = t.org_id from tournaments t where m.tournament_id = t.id and m.org_id is null;
update match_events  e set org_id = t.org_id from tournaments t where e.tournament_id = t.id and e.org_id is null;
update audit_log     a set org_id = t.org_id from tournaments t where a.tournament_id = t.id and a.org_id is null;

-- 3. Indexes for the policy predicate.
create index if not exists players_org_idx      on players(org_id);
create index if not exists rounds_org_idx       on rounds(org_id);
create index if not exists matches_org_idx      on matches(org_id);
create index if not exists match_events_org_idx on match_events(org_id);
create index if not exists audit_log_org_idx    on audit_log(org_id);

-- 4. Trigger: populate org_id from the parent tournament on insert.
--    SECURITY INVOKER (default) means the lookup runs under the caller's RLS,
--    so inserting a child row for a tournament outside the current org finds no
--    tournament, leaves org_id null, and the WITH CHECK below then rejects it.
create or replace function set_org_from_tournament() returns trigger
  language plpgsql as $$
begin
  if new.org_id is null and new.tournament_id is not null then
    select org_id into new.org_id from tournaments where id = new.tournament_id;
  end if;
  return new;
end $$;

do $$
declare tbl text;
begin
  foreach tbl in array array['players','rounds','matches','match_events','audit_log'] loop
    execute format('drop trigger if exists trg_set_org on %I', tbl);
    execute format(
      'create trigger trg_set_org before insert on %I
         for each row execute function set_org_from_tournament()', tbl);
  end loop;
end $$;

-- 5. Replace the sub-select policies with direct org_id comparisons.
--    WITH CHECK on writes prevents inserting/updating a row into another tenant.
drop policy if exists players_tenant on players;
create policy players_tenant on players for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

drop policy if exists rounds_tenant on rounds;
create policy rounds_tenant on rounds for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

drop policy if exists matches_tenant on matches;
create policy matches_tenant on matches for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

drop policy if exists match_events_tenant on match_events;
create policy match_events_tenant on match_events for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

drop policy if exists audit_log_tenant on audit_log;
create policy audit_log_tenant on audit_log for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

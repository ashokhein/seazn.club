-- =============================================================================
-- V298 — Page-system playoffs (IPL style): new 'page_playoff' stage kind.
-- Widens the stages.kind check constraint; the format itself is Pro-gated in
-- the app via the existing formats.double_elim entitlement (no new rows).
-- =============================================================================
do $$ begin
  if exists (
    select 1 from pg_constraint c
    where c.conname = 'stages_kind_check'
      and pg_get_constraintdef(c.oid) not like '%page_playoff%'
  ) then
    alter table stages drop constraint stages_kind_check;
    alter table stages add constraint stages_kind_check
      check (kind in ('league','group','swiss','knockout','double_elim','stepladder',
                      'americano','ladder','page_playoff'));
  end if;
end $$;

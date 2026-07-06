-- =============================================================================
-- Row-Level Security — every tenant table: enable + force + direct policy.
-- =============================================================================
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'sport_variants','persons','player_profiles','teams','competitions',
    'divisions','stages','pools','entrants','entrant_members','fixtures',
    'lineups','score_events','match_states','standings_snapshots',
    'division_events','api_keys','schedule_settings','device_links',
    'competition_events','registration_settings','registrations'
  ] loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force  row level security', tbl);
  end loop;
end $$;

-- sport_variants: system presets (org_id null) are world-readable to any
-- tenant; org variants are private. Writes are always org-scoped.
drop policy if exists sport_variants_tenant on sport_variants;
create policy sport_variants_tenant on sport_variants for all to app_user
  using (org_id is null or org_id = current_org_id())
  with check (org_id = current_org_id());

-- sports: global catalog, read-only for tenants (writes come from the
-- superuser sync script). RLS intentionally stays OFF here, but hosted
-- consoles (Supabase's "enable RLS" lint) may flip it on — the explicit read
-- policy keeps the catalog visible to app_user either way.
drop policy if exists sports_read on sports;
create policy sports_read on sports for select to app_user using (true);

-- Every other tenant table: the plain migration-010 direct policy.
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'persons','player_profiles','teams','competitions','divisions','stages',
    'pools','entrants','entrant_members','fixtures','lineups','score_events',
    'match_states','standings_snapshots','division_events','api_keys',
    'schedule_settings','device_links','competition_events',
    'registration_settings','registrations'
  ] loop
    execute format('drop policy if exists %I on %I', tbl || '_tenant', tbl);
    execute format(
      'create policy %I on %I for all to app_user
         using (org_id = current_org_id()) with check (org_id = current_org_id())',
      tbl || '_tenant', tbl);
  end loop;
end $$;

do $$
declare
  spec text[];
  specs text[][] := array[
    array['divisions',          'competitions', 'competition_id'],
    array['stages',             'divisions',    'division_id'],
    array['pools',              'stages',       'stage_id'],
    array['entrants',           'divisions',    'division_id'],
    array['entrant_members',    'entrants',     'entrant_id'],
    array['fixtures',           'stages',       'stage_id'],
    array['lineups',            'fixtures',     'fixture_id'],
    array['score_events',       'fixtures',     'fixture_id'],
    array['match_states',       'fixtures',     'fixture_id'],
    array['standings_snapshots','stages',       'stage_id'],
    array['division_events',    'divisions',    'division_id'],
    array['player_profiles',    'persons',      'person_id'],
    array['schedule_settings',  'divisions',    'division_id'],
    array['device_links',       'fixtures',     'fixture_id'],
    array['competition_events', 'competitions', 'competition_id'],
    array['registration_settings', 'divisions', 'division_id'],
    array['registrations',      'divisions',    'division_id']
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('drop trigger if exists trg_set_org on %I', spec[1]);
    execute format(
      'create trigger trg_set_org before insert on %I
         for each row execute function set_org_from_parent(%L, %L)',
      spec[1], spec[2], spec[3]);
  end loop;
end $$;

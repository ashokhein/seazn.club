-- `summary` (render-agnostic score lines from the fold cache) rides along for
-- the live public fixture endpoint — it never contains person data.
-- Timetable fields are PUBLISH-GATED (doc 12 §1/PROMPT-17): while a division
-- is still in setup (plan-first draft, timetable not yet published) the
-- public read model nulls scheduled_at/venue/court_label, so the schedule tab
-- and .ics show nothing an organiser has not published. publish-schedule
-- moves the division to 'scheduled' (quick-start moves straight to 'active'),
-- which lights the fields up.
create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

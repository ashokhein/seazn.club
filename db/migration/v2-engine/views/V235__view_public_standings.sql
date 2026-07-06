create or replace view public_standings_v as
  select s.stage_id, s.pool_id, s.rows, s.updated_at, d.id as division_id
  from standings_snapshots s
  join stages st      on st.id = s.stage_id
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

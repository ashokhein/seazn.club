create or replace view public_pools_v as
  select p.id, p.stage_id, p.key, p.name
  from pools p
  join stages st      on st.id = p.stage_id
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

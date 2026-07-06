-- Stage skeleton (kind drives table vs bracket vs ladder rendering, doc 09 §2).
create or replace view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

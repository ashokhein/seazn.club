-- ============================================================
-- V289 — expose entrants.badge_url through public_entrants_v (PROMPT-60).
-- create-or-replace may only APPEND columns, so badge_url goes LAST
-- (same rule as V242's team_display). Body otherwise identical to V242.
-- ============================================================

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles')
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles')
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id),
           '[]'::jsonb) as members,
         case when e.team_id is not null then
           (select jsonb_build_object(
              'club_id',    td.club_id,
              'club_name',  td.club_name,
              'logo_path',  td.logo_path,
              'colors',     td.colors)
            from team_display_v td where td.team_id = e.team_id)
         end as team_display,
         e.badge_url
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and e.status in ('registered','confirmed');

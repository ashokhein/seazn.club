-- Player card source (doc 09 §2): only persons who (a) gave public_name
-- consent AND (b) are rostered in an entrant of a publicly visible
-- competition AND (c) whose org holds `dashboard.player_profiles`
-- (doc 10 §1, PROMPT-13). Everyone else simply does not exist here — the
-- card 404s.
create or replace view public_players_v as
  select p.id, p.org_id, p.full_name as name,
         case when coalesce((p.consent->>'public_photo')::boolean, false)
              then p.photo_path else null end as photo
  from persons p
  where coalesce((p.consent->>'public_name')::boolean, false)
    and org_has_feature(p.org_id, 'dashboard.player_profiles')
    and exists (
      select 1 from entrant_members em
      join entrants e     on e.id = em.entrant_id
      join divisions d    on d.id = e.division_id
      join competitions c on c.id = d.competition_id
      where em.person_id = p.id
        and c.visibility in ('public','unlisted')
        and e.status in ('registered','confirmed'));

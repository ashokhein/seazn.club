-- Entrants with consent-filtered member data (individual/pair entrants expose
-- people; teams expose only the team display). No DOB; photos only if consented.
-- `person_id` is exposed ONLY with public_name consent: it is the link target
-- for the player card, and the card 404s without that consent (doc 06 §4.7) —
-- so a roster row without consent gets initials and no link.
-- Photos and player-card links are additionally Pro read features
-- (doc 10 §1 `dashboard.player_profiles`, PROMPT-13): consent makes them
-- publishable, the entitlement makes them published.
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
           '[]'::jsonb) as members
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and e.status in ('registered','confirmed');

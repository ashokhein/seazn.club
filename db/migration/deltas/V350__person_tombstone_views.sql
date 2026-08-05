-- V350 — #404. A merge TOMBSTONES the absorbed person (V349 added
-- persons.merged_into) instead of deleting it, because six dependent tables are
-- `on delete cascade` and the row has to survive for the merge to be reversible.
-- A tombstone is therefore still a real, RLS-visible `persons` row, and both
-- public views would keep publishing it: `public_entrants_v` until every
-- entrant_members row is repointed, and `public_players_v` for as long as the
-- absorbed row carries consent. Neither is acceptable — the whole point of the
-- merge is that the duplicate stops appearing on the public board.
--
-- Both bodies are copied from their CURRENT definitions with exactly one
-- predicate added. NOTE: `public_entrants_v` was last redefined by V306 (the
-- pass-aware 3-arg org_has_feature), NOT by V289 — copying V289 here would
-- silently revert the Event Pass entitlement fix. `public_players_v` is V307
-- (ungated; its entitlement gate lives in getPublicPlayer). Column lists are
-- untouched: create-or-replace may only APPEND columns, and a reordered list
-- either fails outright or silently changes a public API.

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id
              -- #404: an absorbed duplicate leaves the roster the moment it is
              -- tombstoned, not when its entrant_members row is repointed.
              and p.merged_into is null),
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

create or replace view public_players_v as
  select p.id, p.org_id, p.full_name as name,
         case when coalesce((p.consent->>'public_photo')::boolean, false)
              then p.photo_path else null end as photo
  from persons p
  where coalesce((p.consent->>'public_name')::boolean, false)
    -- #404: a tombstone has no player card. The survivor keeps the consent that
    -- resolved restrictively across both rows, so nothing consented is lost.
    and p.merged_into is null
    and exists (
      select 1 from entrant_members em
      join entrants e     on e.id = em.entrant_id
      join divisions d    on d.id = e.division_id
      join competitions c on c.id = d.competition_id
      where em.person_id = p.id
        and c.visibility in ('public','unlisted')
        and e.status in ('registered','confirmed'));

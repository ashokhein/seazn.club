-- v3/09 §4 (PROMPT-38) — archived divisions vanish from the public site (404).
-- One view feeds every public surface (competition home, division pages,
-- schedule/standings JSON, discovery), so the filter lives here.
create or replace view public_divisions_v as
  select d.id, d.competition_id, d.name, d.slug, d.sport_key, d.variant_key,
         d.status, d.created_at, d.module_version, d.tiebreakers
  from divisions d
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and d.archived_at is null;

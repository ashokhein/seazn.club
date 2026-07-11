-- v3/06 §2 — division Markdown descriptions reach the public page. Keeps
-- V262's archived filter (this view feeds every public surface). New column
-- appended last: `create or replace view` can only add at the end.
create or replace view public_divisions_v as
  select d.id, d.competition_id, d.name, d.slug, d.sport_key, d.variant_key,
         d.status, d.created_at, d.module_version, d.tiebreakers,
         d.description
  from divisions d
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and d.archived_at is null;

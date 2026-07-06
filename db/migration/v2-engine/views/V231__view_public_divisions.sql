-- Divisions of public competitions (doc 08 §3 public competition detail).
-- module_version lets the dashboard resolve the pinned SportModule for
-- MetricSpec-driven standings columns (doc 09 §2 — zero per-sport UI code).
create or replace view public_divisions_v as
  select d.id, d.competition_id, d.name, d.slug, d.sport_key, d.variant_key,
         d.status, d.created_at, d.module_version, d.tiebreakers
  from divisions d
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

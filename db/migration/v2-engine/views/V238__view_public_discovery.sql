-- Discovery read model (doc 15 §4, PROMPT-19; mirrors migration 016): the ONLY
-- source discovery surfaces read. Discoverable ∧ public ∧ not blocked ∧ org
-- active ∧ quality floor. Carries NO person data — consent exposure paths are
-- unchanged (doc 15 §1). Superuser-owned: serves anonymous homepage traffic.
create or replace view public_discovery_v as
select c.id,
       c.name,
       c.slug,
       c.starts_on,
       c.ends_on,
       c.status,
       c.created_at,
       c.discovery->>'city'    as city,
       c.discovery->>'country' as country,
       -- Presentation depth is the paid layer (doc 15 §5).
       case when org_has_feature(c.org_id, 'discovery.branding')
            then c.discovery->>'tagline' end as tagline,
       case when org_has_feature(c.org_id, 'discovery.branding')
            then c.discovery->>'hero_image_path' end as hero_image_path,
       -- Staff-curated featured flag, honoured only while the org holds the
       -- Pro perk (doc 15 §3 — eligible, not guaranteed).
       (c.discovery_featured
         and org_has_feature(c.org_id, 'discovery.featured')) as featured,
       o.name as org_name,
       o.slug as org_slug,
       (select array_agg(distinct d.sport_key)
          from divisions d where d.competition_id = c.id)     as sports,
       (select count(*)::int from entrants e
          join divisions d on d.id = e.division_id
         where d.competition_id = c.id
           and e.status in ('registered','confirmed'))        as entrant_count,
       (select count(*)::int from fixtures f
         where f.division_id in (select id from divisions d where d.competition_id = c.id)
           and f.status = 'in_play')                          as in_play_count,
       (select min(f.scheduled_at) from fixtures f
          join divisions d on d.id = f.division_id
         where d.competition_id = c.id
           and d.status <> 'setup'                            -- publish-gated (doc 12 §1)
           and f.status = 'scheduled'
           and f.scheduled_at >= now())                       as next_fixture_at
from competitions c
join organizations o on o.id = c.org_id
where c.discoverable
  and c.visibility = 'public'
  and not c.discovery_blocked
  and o.status = 'active'
  -- Quality floor (doc 15 §3): email-verified owner…
  and exists (select 1 from org_members m join users u on u.id = m.user_id
               where m.org_id = o.id and m.role = 'owner' and u.email_verified)
  -- …and ≥1 decided fixture or a published schedule (division past setup).
  and (exists (select 1 from fixtures f join divisions d on d.id = f.division_id
                where d.competition_id = c.id
                  and f.status in ('decided','finalized'))
    or exists (select 1 from divisions d
                where d.competition_id = c.id
                  and d.status in ('scheduled','active','completed')));

-- Branding is a Pro read feature (doc 10 §1, key `dashboard.branding` since
-- PROMPT-13) — nulled here, server-side, for non-entitled orgs. `visibility`
-- rides along so pages can render unlisted competitions with a noindex meta
-- and keep them out of the sitemap.
create or replace view public_competitions_v as
  select id, org_id, name, slug, description, starts_on, ends_on,
         case when org_has_feature(org_id, 'dashboard.branding') then branding
              else '{}'::jsonb end as branding,
         status, created_at, visibility
  from competitions
  where visibility in ('public','unlisted');

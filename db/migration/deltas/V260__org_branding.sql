-- =============================================================================
-- Org-level branding (brand color for public pages + slideshow theming)
-- =============================================================================
-- Same shape as competitions.branding ({ colors: { primary: "#hex" } }).
-- Resolution chain: competition.branding.colors.primary overrides this,
-- platform violet is the fallback. Reads are gated by dashboard.branding
-- (Pro) at the query site — the column itself is written unconditionally,
-- like competitions.branding.
alter table organizations
  add column if not exists branding jsonb not null default '{}'::jsonb;

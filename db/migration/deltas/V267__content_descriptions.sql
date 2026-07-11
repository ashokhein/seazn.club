-- =============================================================================
-- Rich descriptions (v3/06 §2)
-- =============================================================================
-- Markdown everywhere the editor reaches: competitions.description already
-- exists (now interpreted as Markdown); divisions and the org "about" join it.
alter table divisions
  add column if not exists description text;

alter table organizations
  add column if not exists about text;

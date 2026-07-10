-- v3/09 §4 (PROMPT-38) — division archive lifecycle. Archived divisions are
-- hidden from the console, the public site (404) and entitlement counts, and
-- restorable from competition settings; hard delete stays reserved for
-- setup-state divisions and 30-day-old archives (purge).
alter table divisions add column if not exists archived_at timestamptz;

-- Quota counts and console lists read active divisions per competition.
create index if not exists divisions_active_idx
  on divisions(competition_id) where archived_at is null;

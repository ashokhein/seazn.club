-- v1 public-URL redirects (/t/{slug}) are no longer needed — the /t route and
-- the migration step that populated this table have both been removed.
drop table if exists v1_slug_redirects;

-- =============================================================================
-- Grants — re-grant across all tables/sequences so the v2 tables (created after
-- schema.sql's grant ran) are reachable by app_user under RLS. Views are
-- granted read to app_user; they are also readable by the superuser API path.
-- =============================================================================
grant usage on schema ${flyway:defaultSchema} to app_user;
grant select, insert, update, delete on all tables in schema ${flyway:defaultSchema} to app_user;
grant usage, select on all sequences in schema ${flyway:defaultSchema} to app_user;
-- competition_events is append-only for the app (doc 15 §1 audit): re-narrow
-- after the blanket grant above.
revoke update, delete on competition_events from app_user;
grant app_user to postgres;
grant select on public_competitions_v, public_divisions_v, public_fixtures_v,
                public_standings_v, public_entrants_v, public_players_v,
                public_stages_v, public_pools_v, public_discovery_v to app_user;

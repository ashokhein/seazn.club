-- v1→v2 migration bookkeeping table. The migration script that created and
-- consulted it (scripts/migrate-v1-to-v2.ts) has been removed; drop the table.
drop table if exists v1_migration_map;

-- =============================================================================
-- Row Level Security (RLS) — tenant isolation
-- =============================================================================
-- The app connects as the `postgres` superuser, which bypasses RLS by default.
-- To enforce policies, `withTenant(orgId)` in db.ts switches the transaction
-- to the `app_user` role (non-superuser) and sets `app.current_org` before
-- any mutation runs. Reads via `loadState`/`loadBundle` stay as superuser
-- since they are already guarded by the API auth layer.
-- =============================================================================

-- Restricted application role (non-superuser so RLS is enforced).
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant usage on schema ${flyway:defaultSchema} to app_user;
grant select, insert, update, delete on all tables in schema ${flyway:defaultSchema} to app_user;
grant usage, select on all sequences in schema ${flyway:defaultSchema} to app_user;

-- Allow the connection role to switch into app_user (required for SET ROLE).
grant app_user to postgres;

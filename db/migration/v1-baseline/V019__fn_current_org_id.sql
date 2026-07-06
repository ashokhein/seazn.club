-- Helper: extract the current org UUID from the session config, or NULL.
-- Returns NULL (not empty string) when the setting is absent, which causes
-- the USING expression to evaluate to NULL (= no access) rather than error.
create or replace function current_org_id() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('app.current_org', true), '')::uuid
  $$;

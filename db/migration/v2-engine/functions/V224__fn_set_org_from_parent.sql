-- =============================================================================
-- org_id trigger — one GENERIC set_org_from_parent() (doc 07 note 1).
-- Passed (parent_table, fk_column) via TG_ARGV. SECURITY INVOKER (default): the
-- parent lookup runs under the caller's RLS, so a child row pointed at a parent
-- in another tenant finds no parent, leaves org_id null, and the policy's
-- WITH CHECK then rejects it (same guarantee as migration 010).
-- =============================================================================
create or replace function set_org_from_parent() returns trigger
  language plpgsql as $$
declare
  parent_table text := tg_argv[0];
  fk_column    text := tg_argv[1];
  fk_value     uuid;
  parent_org   uuid;
begin
  if new.org_id is not null then return new; end if;
  -- Extract the FK value generically (avoids dynamic composite-field access).
  fk_value := (to_jsonb(new) ->> fk_column)::uuid;
  if fk_value is null then return new; end if;
  execute format('select org_id from %I where id = $1', parent_table)
    into parent_org using fk_value;
  new.org_id := parent_org;
  return new;
end $$;

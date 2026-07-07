-- =============================================================================
-- Jul3/08 — Format engine extensions (PROMPT-28): americano + ladder stage
-- kinds, auto-progress flag, formats.advanced entitlement.
-- =============================================================================
do $$ begin
  if exists (
    select 1 from pg_constraint c
    where c.conname = 'stages_kind_check'
      and pg_get_constraintdef(c.oid) not like '%americano%'
  ) then
    alter table stages drop constraint stages_kind_check;
    alter table stages add constraint stages_kind_check
      check (kind in ('league','group','swiss','knockout','double_elim','stepladder',
                      'americano','ladder'));
  end if;
end $$;

-- Auto-advance (Jul3/08 §5, 16 Sep): progression fires without a button.
alter table divisions add column if not exists
  auto_progress boolean not null default false;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'formats.advanced', false, null),
  ('pro',       'formats.advanced', true,  null),
  ('business',  'formats.advanced', true,  null)
on conflict (plan_key, feature_key) do nothing;

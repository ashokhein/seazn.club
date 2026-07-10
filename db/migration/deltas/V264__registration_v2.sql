-- v3/05 (PROMPT-34) — registration v2: quotable reference numbers, and the
-- youth-privacy defaults from v3/11 gap 8.

-- Human-quotable reference (SZ-XXXX-XXXX, crockford-style base32 + checksum),
-- generated app-side with a collision-retry loop. Pre-v2 rows keep NULL —
-- the organiser panel and /r/[ref] treat missing refs as "issued before refs".
alter table registrations add column if not exists ref_code text;
create unique index if not exists registrations_ref_code_key
  on registrations(ref_code) where ref_code is not null;

-- Youth flag (v3/11 gap 8): auto-set when eligibility declares an under-18
-- bound, organiser-overridable afterwards. Backfill from existing rules.
alter table divisions add column if not exists youth boolean not null default false;
update divisions d set youth = true
where youth = false
  and exists (
    select 1 from jsonb_array_elements(d.eligibility) r
    where r->>'kind' = 'age' and coalesce((r->>'maxAgeAt')::int, 99) < 18
  );

-- Public name rendering per division: full | first_initial. NULL resolves at
-- read time (youth → first_initial, else full) so flipping the youth flag
-- keeps working without a second write.
alter table divisions add column if not exists player_name_display text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'divisions_player_name_display_check') then
    alter table divisions add constraint divisions_player_name_display_check
      check (player_name_display in ('full', 'first_initial'));
  end if;
end $$;

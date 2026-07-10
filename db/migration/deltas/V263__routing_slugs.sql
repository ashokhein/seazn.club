-- PROMPT-30 (v3/01): console slug routing.
--
-- 1. slug_history — old slugs after a rename keep redirecting (console /o/...
--    and public /shared). Lookup runs before tenant context exists (org slug
--    resolution, anon public pages), so like organizations it carries no RLS.
-- 2. fixtures.fixture_no — human-quotable per-division ordinal for
--    /o/../f/[no] URLs ("look at match 14"). A BEFORE INSERT trigger numbers
--    every insert path (stage generation, ladder challenges, history
--    restores) without app changes. Ordinals are not permalinks: regenerating
--    a stage renumbers.

create table slug_history (
  entity_type text not null check (entity_type in ('org','competition','division')),
  parent_id   uuid,          -- org_id for competitions, competition_id for divisions, null for orgs
  old_slug    text not null,
  entity_id   uuid not null,
  created_at  timestamptz not null default now()
);

-- One redirect target per (scope, old slug); nullable parent folded to a
-- sentinel so org rows also dedupe.
create unique index slug_history_lookup_key
  on slug_history (entity_type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), old_slug);

alter table fixtures add column fixture_no int;

update fixtures f set fixture_no = t.rn
from (select id, row_number() over (partition by division_id
        order by round_no, seq_in_round, created_at, id) as rn
      from fixtures) t
where f.id = t.id;

alter table fixtures alter column fixture_no set not null;
create unique index fixtures_division_no_key on fixtures (division_id, fixture_no);

create function assign_fixture_no() returns trigger language plpgsql as $$
begin
  if new.fixture_no is null then
    -- Serialise per division: concurrent inserts would otherwise both read
    -- the same max. Advisory xact lock is released at commit.
    perform pg_advisory_xact_lock(hashtext('fixture_no:' || new.division_id::text));
    select coalesce(max(fixture_no), 0) + 1 into new.fixture_no
      from fixtures where division_id = new.division_id;
  end if;
  return new;
end $$;

create trigger fixtures_assign_no before insert on fixtures
  for each row execute function assign_fixture_no();

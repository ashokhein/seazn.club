-- V349 — #404. A merge must be reversible (Art. 16 rectification), so the
-- absorbed person is TOMBSTONED rather than deleted: six dependent tables are
-- `on delete cascade`, and deleting the row destroys discipline history, stats,
-- team memberships, account claims and RSVPs with it.
alter table persons add column if not exists merged_into uuid references persons(id) on delete set null;
comment on column persons.merged_into is
  '#404: set when this person was absorbed by another. Non-null = tombstone: '
  'hidden from every roster read and public view, kept so the merge can be '
  'undone. Always points at a LIVE person — chains are flattened on merge.';

-- A tombstone must not hold the identity slot: the survivor now owns the
-- (org_id, user_id) pair and the next registration has to land on it. The
-- ON CONFLICT at registrations.ts:456 must repeat this predicate VERBATIM —
-- Postgres only infers a partial index whose predicate the statement implies.
drop index if exists persons_org_user_lane_uq;
create unique index persons_org_user_lane_uq
  on persons (org_id, user_id, lane)
  where user_id is not null and lane = 'player' and merged_into is null;

-- The audit trail AND the undo record.
create table if not exists person_merges (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  survivor_id   uuid not null references persons(id) on delete cascade,
  absorbed_id   uuid not null references persons(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  -- Full prior state of BOTH persons rows plus every dependent row moved or
  -- resolved, as {table: [row, …]}. A diff is not enough: reversal has to
  -- reconstruct rows that were merged away, not just flip a pointer.
  snapshot      jsonb not null,
  created_at    timestamptz not null default now(),
  reversed_at   timestamptz,
  reversed_by   uuid references users(id) on delete set null,
  check (survivor_id <> absorbed_id)
);
create index if not exists person_merges_org_idx on person_merges (org_id, created_at desc);
-- One LIVE merge per absorbed person; a reversed one may be superseded.
create unique index if not exists person_merges_absorbed_live_uq
  on person_merges (absorbed_id) where reversed_at is null;
-- Index the survivor FK too: the history panel reads "merges into this person",
-- and an unindexed FK makes `on delete cascade` from persons a sequential scan.
-- (absorbed_id is already covered by person_merges_absorbed_live_uq.)
create index if not exists person_merges_survivor_idx on person_merges (survivor_id);

alter table person_merges enable row level security;
alter table person_merges force  row level security;
drop policy if exists person_merges_tenant on person_merges;
create policy person_merges_tenant on person_merges for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on person_merges to app_user;

comment on table person_merges is
  '#404: one row per person merge. Holds the snapshot that makes the merge '
  'reversible at any time, and is itself the audit trail (#403 R2/R3).';

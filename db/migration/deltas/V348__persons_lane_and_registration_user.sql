-- V348 — #402 registration person identity.
--
-- #396 planned a partial unique index on persons(org_id, user_id). It was
-- reverted (d01c2c55) because one user legitimately holds a player person AND
-- an official person in one org, so the pair is not unique. `lane` supplies the
-- missing third column: registration resolves the player lane, officials keep
-- their own, and the index the design asked for can finally land.
alter table persons
  add column lane text not null default 'player'
  check (lane in ('player','official'));

-- A person referenced by `officials` and never rostered is an official-lane row.
-- A person that is BOTH stays 'player': registration must resolve them, and the
-- officials FK works regardless of lane. Greenfield, so this is a convenience
-- for local and demo databases, not a production backfill.
update persons set lane = 'official'
 where exists (select 1 from officials o where o.person_id = persons.id)
   and not exists (select 1 from entrant_members em where em.person_id = persons.id);

-- Scoped to the PLAYER lane, and only the player lane.
--
-- The first cut of this index covered every lane — "one person per (user, org,
-- lane)" — on the reasoning that the only collision left was two player rows.
-- That reasoning missed `inviteOfficial`: it mints a FRESH lane='official'
-- person for every officials row whose person_id is null, and it cannot dedupe,
-- because at invite time the person is unclaimed and the user is unknown. An
-- org that carries the same human on its officials roster twice therefore
-- produces two official-lane persons for one account, which is long-standing
-- and legitimate (smoke.ts:3507). The lane-wide index turned the second
-- officiating claim into a 409.
--
-- #402 only ever needed uniqueness where registration resolves — the player
-- lane, the lane `resolvePlayerPerson` upserts on. `lane` stays in the key so
-- `on conflict (org_id, user_id, lane)` can still infer this index; the
-- predicate is what confines it. Note that the matching ON CONFLICT clause must
-- repeat `lane = 'player'`: Postgres only infers a partial index whose
-- predicate is implied by the one the statement supplies.
create unique index persons_org_user_lane_uq
  on persons (org_id, user_id, lane)
  where user_id is not null and lane = 'player';

-- The registrant's session, captured only under an explicit affirmation with no
-- guardian fields (see submitRegistration). Nullable by design: registration
-- works with no account. `on delete set null` so removing an account does not
-- cascade away the registration record.
alter table registrations
  add column user_id uuid references users(id) on delete set null;

create index if not exists registrations_user_idx
  on registrations (user_id) where user_id is not null;

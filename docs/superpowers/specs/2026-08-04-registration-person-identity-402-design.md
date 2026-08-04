# Registration person identity — design (#402)

Date: 2026-08-04
Issue: #402 · Programme: #395 · Depends on: #396 (see "The dependency did not
ship") · Hands off to: #404 (duplicate review queue + merge tool)
Supersedes the shape sketched in `2026-07-30-scheduler-verified-output-design.md`
§9.1 and in `2026-08-02-verified-scheduling-wave-prompts.md` Session 7.

## 1. The problem, and why the issue's shape does not work as written

`materialise` (`registrations.ts:391-426`) inserts unconditionally: line 398 on
the individual path, line 410 per team-roster name. The same human entering two
divisions receives two `person_id`s, so stats, discipline history, profiles and
photos fragment.

#402 proposes resolving an existing person on `(org_id, user_id)` before
inserting, and names #396's partial unique index on that pair as a hard
dependency.

**The dependency did not ship.** #396 merged as PR #408 with zero migration
files. `cc440822` added `V345__persons_org_user_unique.sql`; `d01c2c55` reverted
it the same day, before merge, on an owner decision:

> One user legitimately holds several persons rows in one org — a player person
> and an official person — and `listMyPersons` resolves entitlements per person
> ROW, which `me.test.ts:162` pins deliberately. In production `inviteOfficial`
> mints a second person for the same human and `acceptResolvedClaim` then runs a
> bare `update persons set user_id`, so with the index applied a user who claims
> both a player and an official profile in one org gets a 500 carrying the
> constraint name.

Verified against `main` (ba889011): `persons` (V204) carries only
`persons_org_idx on persons(org_id)`; the sole `user_id` index (V275:15-16) is
non-unique. `officials.person_id` (V243:11) is the only thing distinguishing an
official person from a player person, and it lives on another table.

So `(org_id, user_id)` selects **two or more rows** for a player who is also an
official. Resolving on it as written can attach a player's registration to their
*official* person — fusing records across lanes, which is the same class of harm
the issue's own anti-merge rule exists to prevent.

**Second, unfiled problem: `user_id` reintroduces the sibling-merge bug.** #402
rules out `contact_email` because a guardian registering two children shares one
address. A *signed-in* guardian registering two children shares one `user_id`
too. Capturing the session naively makes both children resolve to the parent's
person: one `persons` row for two children. Same corruption, new key. The same
hole is open for a signed-in adult registering a spouse or a teammate, who leave
no guardian fields at all.

## 2. Decisions (owner, 2026-08-04)

1. **A lane discriminator makes the key unique.** `persons.lane` is
   `'player' | 'official'`; the unique index becomes
   `(org_id, user_id, lane) where user_id is not null and lane = 'player'`.
   Registration always resolves the player lane. This removes the exact
   collision the revert cited, so the index the design doc asked for can
   finally land.

   **The `lane = 'player'` half of that predicate is load-bearing, and it was
   learned the hard way.** An earlier draft of this design constrained every
   lane, on the reasoning that "the only remaining collision is two player
   persons for one human in one org". That reasoning is wrong, and smoke caught
   it: `inviteOfficial` mints a person unconditionally and *cannot* dedupe,
   because at invite time the person is unclaimed and the account behind the
   email is not knowable. Two official-lane persons for one user in one org is
   therefore legitimate, long-standing behaviour — an organiser inviting the
   same referee twice — and constraining it broke officiating claims with a 409
   on a previously passing path. Uniqueness belongs only where registration
   actually resolves. Consequence for callers: Postgres infers a partial arbiter
   index only when the statement's predicate implies the index's, so the upsert
   in `materialise` must repeat `and lane = 'player'` in its `on conflict`
   clause or it fails with "no unique or exclusion constraint matching the ON
   CONFLICT specification".
2. **Linking requires an explicit affirmation, with a server-side guardian
   veto.** `registrations.user_id` is written only when the registrant is signed
   in **and** affirmed "I'm registering myself" **and** the row carries no
   guardian fields. The veto is server-side, so a forged request cannot link a
   child to a parent.
3. **The registrant declares which roster entry is them.** On a team
   registration the signed-in, self-registering submitter picks their own row
   from the names they typed. That entry resolves by `(org_id, user_id,
   'player')`; every other roster name inserts fresh, exactly as today. The
   declaration is the user's, not an algorithm's — no name or dob matching is
   introduced anywhere.

Unchanged from the issue: name and dob **suggest only**, never auto-merge.

## 3. Schema — V348

```sql
alter table persons
  add column lane text not null default 'player'
  check (lane in ('player','official'));

-- A person referenced by `officials` and never rostered is an official-lane row.
-- A person that is BOTH stays 'player': registration must resolve them, and the
-- officials FK keeps working regardless of lane.
update persons set lane = 'official'
 where exists (select 1 from officials o where o.person_id = persons.id)
   and not exists (select 1 from entrant_members em where em.person_id = persons.id);

-- Scoped to the player lane on purpose: see §2 decision 1. Constraining the
-- official lane breaks officiating claims, because inviteOfficial mints
-- unconditionally and cannot know which account an unclaimed invite belongs to.
create unique index persons_org_user_lane_uq
  on persons (org_id, user_id, lane)
  where user_id is not null and lane = 'player';

alter table registrations
  add column user_id uuid references users(id) on delete set null;
```

`registrations.user_id` is nullable and `on delete set null`: a deleted account
must not cascade away a registration record. No column stores the affirmation
separately — `user_id is not null` *is* the record that it was given.

Greenfield, so the `update` is a convenience for local and demo databases rather
than a production backfill.

## 4. Server flow

**Capture (public route only).** `POST /api/v1/public/orgs/[orgSlug]/
competitions/[slug]/register` calls `getCurrentUser()` (`lib/auth.ts:86`, cookie
+ JWT, returns `null` when absent) and passes the id to `submitRegistration` as
an option. Resolving the session *in the route* and passing it inward keeps the
organiser-facing entry paths structurally unable to supply one — an organiser
adding an entry on someone's behalf must never bind their own `user_id` to a
player's person.

```ts
const linkUserId =
     sessionUser?.id
  && input.registering_self === true
  && !input.guardian_name
  && !input.guardian_consent
   ? sessionUser.id
   : null;
```

**Request schema.** `PublicRegisterRequest` gains optional
`registering_self: boolean` and an optional `self: boolean` on roster entries.
Validation: at most one roster entry may set `self`, and `self` requires
`registering_self` — otherwise 400. `roster` is already `jsonb`, so the flag
needs no migration.

**Resolve (`materialise`).** When `reg.user_id` is null the code path is byte-for
-byte today's insert; the anonymous flow cannot regress. When it is set:

```sql
insert into persons (org_id, full_name, dob, gender, user_id, lane)
values (${orgId}, ${name}, ${dob}, ${gender}, ${userId}, 'player')
on conflict (org_id, user_id, lane) where user_id is not null
do update set full_name = persons.full_name
returning id
```

The no-op `do update` is deliberate: `do nothing` returns no row, forcing a
second round trip and reopening the race. `persons.full_name` on the right-hand
side means an existing person's own data wins — a later registration never
overwrites `full_name`, `dob`, `gender` or `consent`. Divergence between what
was typed and what the person row holds is a signal for #404's queue, never an
in-place edit, and consent is never widened.

This also closes a race the issue's SELECT-then-INSERT shape leaves open: two
concurrent registrations by one signed-in user in two divisions both miss the
select and both insert. Here the unique index arbitrates and the loser returns
the winner's id.

**Team path.** The roster loop resolves via the same upsert for the entry
flagged `self` when `reg.user_id` is set; every other entry keeps today's plain
insert.

**`inviteOfficial`** (`officials.ts:154-156`) inserts `lane = 'official'`.

**`acceptResolvedClaim`** (`person-claims.ts:211-225`) does a bare
`update persons set user_id`. Under the new index that raises `23505` for a user
who already holds a *player* person in the org and claims a second one — which
is exactly the duplicate #402 exists to eliminate. So the update catches `23505`
and throws `HttpError(409, …, "PERSON_ALREADY_LINKED")`, pointing at the merge
route rather than crashing. This is the piece the reverted V345 lacked.

Because the index is scoped to the player lane, an *officiating* claim never
reaches this branch: a referee invited twice into one org holds two official-lane
persons, and claiming the second is a 200, unchanged from before this work.

## 5. UI

Public registration form (`(public)/shared/[orgSlug]/[competitionSlug]/
register/page.tsx`):

- When signed in: a checkbox, "I'm registering myself". Unchecked by default —
  the safe state is "no link".
- When the checkbox is on **and** the form is in team mode: a select over the
  roster names already entered, "Which of these is you?".
- Both controls hide entirely when signed out, and hide when guardian fields are
  filled, so the anonymous and guardian flows look exactly as they do today.

Every new string lands in all four locale dictionaries (flat dotted keys). The
registration help article is updated; `content/help/**` is one English tree and
owes no i18n work. Verified by screenshot at desktop and 375px, no horizontal
page scroll.

## 6. Testing

| Kind | Assertion |
| --- | --- |
| Unit | `linkUserId` derivation: signed-out, signed-in-not-affirmed, affirmed, affirmed-with-guardian, affirmed-with-guardian-consent |
| Unit | roster validation rejects two `self` entries, and `self` without `registering_self` |
| Regression (the issue's headline) | signed-in registrant, affirmed, two divisions ⇒ **one** `persons` row |
| Regression (anti-merge, permanent) | signed-in guardian, two children, one `contact_email`, one `user_id` ⇒ **two** `persons` rows |
| Regression | anonymous registration still succeeds, still creates a person, `registrations.user_id` null |
| Regression | organiser-side entry creation binds no `user_id` |
| Regression | `acceptResolvedClaim` second player claim ⇒ 409 `PERSON_ALREADY_LINKED`, not 500 |
| Regression | a referee invited TWICE into one org claims both ⇒ **200 both times**, no 409 — the official lane is deliberately unconstrained (§2 decision 1) |
| Regression | `me.test.ts:162` stays green — a user linked only as an official keeps `hasPhotoFeature === false` |
| Index | duplicate `(org_id, user_id, 'player')` rejected; same `user_id` across two *lanes* accepted; two null `user_id`s accepted |
| Race | two concurrent affirmed registrations ⇒ one `persons` row, both entrants materialise |
| Team | roster of three, one flagged `self` ⇒ that person resolves, other two insert fresh |
| E2E | signed-in registrant completes the public form with the affirmation, at desktop and 375px |
| Smoke | affirmed signed-in registration in two divisions yields one person |

## 7. Out of scope

The duplicate review queue, the merge tool, and any backfill of historic
duplicates stay on #404. Roster members other than the declared self are not
linked — they have no identity of their own, and name matching may only suggest.
Anonymous registration keeps working with no account, deliberately.

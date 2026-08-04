# Duplicate-person review queue + merge tool — design

Issue #404. Data-protection requirements from #403 (posted as a comment there and
on #404). Cause and evidence in #395 gap 8 and #402.

## 1. Problem

`persons` accumulates duplicate rows for one human. `registrations.ts:398` inserts
a fresh person on every confirmed individual registration and `:411` mints one per
team-roster name; `entrants.ts:35` states it as policy — *"Inline persons are never
merged with existing org persons."* Public registration is anonymous, so there is
no deterministic key to link on (#402 narrowed the cause fix to signed-in
registrants only).

W1's scheduling name guard (#396) makes the **schedule** safe despite this — it
groups same-name persons for rest and overlap inside one run and writes nothing.
The **records** stay fragmented: stats, discipline history, profiles and photos
split across rows for the same human.

### 1.1 A merge already ships, and it must be replaced

`mergePersons` (`apps/web/src/server/usecases/persons.ts:131-163`) is live behind
`POST /api/v1/persons/:id/merge` (`app/api/v1/persons/[id]/merge/route.ts:9-15`,
schema `api-v1/schemas.ts:297`, published in `openapi.ts:71`). No UI calls it.

It repoints `entrant_members`, `lineups` and `player_profiles` — **deleting** rows
that would collide rather than resolving them — then runs
`delete from persons where id = duplicateId`. Six dependent tables are
`on delete cascade`, so that single statement destroys the absorbed person's
discipline history (`suspensions`), stats (`player_stat_snapshots`), club
membership (`team_members`), account claim (`person_claims`) and RSVPs
(`fixture_availability`); `officials.person_id` is silently nulled. There is no
audit row, no snapshot, no consent resolution and no confirmation gate — any
`write`-scoped principal, including an API key, can do it in one POST.

Greenfield, so no production data is at risk and no UI path reaches it. But it is
the thing this design replaces, not a foundation to build on.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Surface | Organiser-facing, beside People at `/directory` | The organiser knows which "J Smith" is which; staff cannot. Full design polish + 375px. |
| Undo window | **Unbounded** | Art. 16 rectification has no expiry, and a duplicate is often noticed a season later. |
| Absorbed row | **Tombstone** `persons.merged_into`, never deleted | Deleting triggers six cascades. A tombstone makes reversal cheap and lossless. |
| Two claimed accounts | **Refuse** | Two distinct logins is stronger evidence of two humans than a matching name. |
| Differing `dob` | Never suggested; merge-able only by explicit hand-picked action | A typo must stay fixable; the tool must never *nudge* toward merging two minors. |
| `entrant_members` collision | Field-wise, strongest wins | Same human on the same team — nothing they held should silently vanish. |
| Merge chains | **Flatten on merge** | `merged_into` always names a live person, so every read stays one check. |
| Candidate computation | On-demand SQL, no materialised table | Hundreds of people per org. A stale queue's failure mode is a wrong merge. |

## 3. Data

```sql
persons.merged_into uuid references persons(id) on delete set null
```

Non-null = tombstone: invisible to every roster read and both public views, kept
so the merge can be undone. **Always points at a live person** (§4.3).

```sql
person_merges (
  id, org_id, survivor_id, absorbed_id, actor_user_id,
  snapshot jsonb not null,        -- {table: [row, …]} — full prior state
  created_at, reversed_at, reversed_by
)
```

`snapshot` holds both `persons` rows **and every dependent row moved or resolved**,
not a diff: reversal must reconstruct rows that were merged away, not just flip a
pointer. One live merge per absorbed person
(`person_merges_absorbed_live_uq on (absorbed_id) where reversed_at is null`).
RLS enabled + forced, tenant policy `org_id = current_org_id()` to `app_user`,
matching every neighbouring table.

**The identity index must exclude tombstones.** `persons_org_user_lane_uq`
(`V348:38-40`) becomes
`on persons (org_id, user_id, lane) where user_id is not null and lane = 'player'
and merged_into is null` — otherwise a tombstone holds the identity slot and the
next registration for that human collides. Its `ON CONFLICT` twin at
`registrations.ts:456` **must repeat the new predicate verbatim**: Postgres only
infers a partial index whose predicate the statement implies.

## 4. The merge

One `withTenant` transaction. A partial merge is worse than none.

### 4.1 Refusals, before anything is written

- `survivor == absorbed` → 422.
- Different `org_id` → 422. `trg_set_org` (`V225:24-30`) is **BEFORE INSERT only**,
  so an UPDATE repointing a row would leave `org_id` stamped with the old tenant.
- Both rows carry a **non-null and different** `user_id` → 422, naming both
  accounts. Same `user_id` on both is fine (that is one human, twice).
- Either row is already a tombstone → 409.
- Different non-null `dob` → allowed **only** with the explicit hand-picked flag;
  refused when the pair came from a suggestion.

### 4.2 Order of work

1. **Snapshot** both `persons` rows and every dependent row, into `snapshot`.
2. **Resolve consent** onto the survivor: per flag, `survivor && absorbed`. If the
   resolved `public_photo` is false, the absorbed `photo_path` must not become
   reachable from any public surface. A merge is not a consent event and may never
   widen what a person agreed to.
3. **Repoint** each table (§4.3).
4. **Flatten** inbound tombstones: every row with `merged_into = absorbed` is
   repointed to the survivor, and those rows go in the snapshot too.
5. **Tombstone** the absorbed row (`merged_into = survivor`). Never delete.
6. **Write** the `person_merges` row.
7. **Re-verify** published boards (§5), outside the write gate.

### 4.3 Per-table repoint rules

| table | collision key | rule |
|---|---|---|
| `entrant_members` | PK `(entrant_id, person_id)` | Field-wise: `is_captain` = either; `roles` = union; `squad_number` = survivor's, else the absorbed one. |
| `player_profiles` | PK `(person_id, sport_key)` | Survivor's profile wins per sport; the absorbed profile is kept in the snapshot. |
| `lineups` | PK `(fixture_id, entrant_id, person_id)` | Survivor's row is kept, absorbed row snapshotted and dropped. A historical lineup records who played, and one human cannot appear twice in it. |
| `team_members` | PK `(team_id, person_id)` | Survivor's row wins. |
| `player_stat_snapshots` | PK `(division_id, person_id)` | **Recomputed, never picked** — these are aggregates, and choosing one row silently halves a season. Delete both rows and call `recomputePlayerStats(tx, divisionId)` (`player-stats.ts:29`, already `on conflict (division_id, person_id) do update`) for every division either person appeared in. It folds from score events, which reference users rather than persons, so it is authoritative after the repoint. |
| `fixture_availability` | PK `(fixture_id, person_id)` | Most recent response wins. |
| `person_claims` | partial unique `(person_id) where claimed_at is null and revoked_at is null` | Survivor's open claim is kept; the absorbed open claim is **revoked with a reason**, never deleted. |
| `suspensions` | partial unique `(division_id, person_id, rule_key, bucket)` | All rows move. A collision means the same auto-accumulation fired for both records — keep the earlier, snapshot the other. |
| `officials` | FK, `on delete set null` | Repointed only when `lane = 'official'` on both. Officials mint unconditionally and cannot dedupe (`V348`), so the queue never proposes cross-lane pairs. |

### 4.4 Reversal

`reverseMerge(mergeId)` replays the snapshot backwards: restore both `persons`
rows (including the absorbed person's own consent flags — the restrictive
resolution applied to the survivor is undone too), put every snapshotted row back
on its original `person_id`, restore flattened tombstones to pointing at the
absorbed person, clear `merged_into`, stamp `reversed_at`/`reversed_by`. Rows
created **after** the merge stay with the survivor; only snapshotted rows move.
Reversing an already-reversed merge is 409. The row is kept, never deleted.

## 5. Re-verify after a merge

A merge can **create** person-overlap in a board that was valid when it was
published: two entrants holding the two duplicates, scheduled at the same time on
different courts, become one human on two courts.

After the merge commits, re-verify every published board the survivor appears in
and return the conflicts on the merge response. Per the W4 delta rule, the merge
is **not blocked** by what it reveals — refusing would leave the duplicate in
place and the board still wrong. `assertNoNewBlocking` (`schedule.ts:573`) is
module-private; call the verifier through the exported `toVerifyConfig`
(`schedule.ts:488`).

Once the merge lands, W1's name guard stops firing for that pair on its own —
`personKeyResolver` buckets same-name persons with *differing* ids, and there is
now one id. The assumption row vanishing from the review panel is the
organiser-visible signal that the merge took effect.

## 6. Candidates

`listDuplicateCandidates(auth, opts)` returns ranked pairs with **evidence**, since
the organiser is the one deciding:

- normalised-name equality (the `(nameKey, dob)` shape of
  `packages/engine/src/import/plan.ts:220-282`, reimplemented — that matcher is not
  exported and the data lives in Postgres);
- `dob` agreement raises the rank; **differing `dob` suppresses the pair entirely**;
- shared entrant history raises the rank;
- same `lane` required; tombstones excluded on both sides; pairs where both rows
  carry different `user_id`s excluded (they can never be merged).

## 7. Surface

Beside People at `/directory` (`app/directory/page.tsx`, `components/v2/persons-panel.tsx`).
States: empty queue · ranked list with evidence · confirm dialog showing a
side-by-side record diff **and the resolved consent** · post-merge result listing
any schedule conflicts revealed · merge history with Undo · reversal confirmation.
Desktop and 375px, no horizontal page scroll, wide comparison tables in
`overflow-x: auto`. All strings in 4 locales; one English help page.

## 8. API

- `GET /api/v1/persons/duplicates` — the ranked queue.
- `POST /api/v1/persons/:id/merge` — gains a required explicit confirmation field
  and the hand-picked flag for the dob case. Refused for API-key principals: a
  merge is a human act, following the `NEVER_KEY_ROUTES` precedent used for
  competition delete.
- `POST /api/v1/persons/merges/:id/reverse` — same confirmation requirement.

## 9. Testing

Every change ships a test that fails without it; unit, e2e, smoke and a regression
test per the repo rule. The load-bearing ones:

1. **Nothing is destroyed** — a merge preserves suspensions, stat snapshots, team
   memberships, claims and availability. *Fails against the code as it stands.*
2. **Round trip** — merge then reverse restores both people byte-identically.
3. **Consent resolves restrictive**, asserted in both directions so "survivor wins"
   cannot pass.
4. **PK-safe repoint** on all six composite keys, plus both partial uniques.
5. **Refusals**: cross-org, two accounts, tombstone, suggested-pair dob conflict.
6. **Chain flattening** — A→B then B→C leaves `A.merged_into = C`, and reversing
   B→C restores `A.merged_into = B`.
7. **Re-verify fires and does not block.**
8. **Lane respected** — an official is never a candidate for a player.
9. DB-backed suites guard with `describe.skipIf(!HAS_DB)` — CI's unit job has no
   `DATABASE_URL`, and omitting this failed CI on #470.

## 10. Out of scope

The production backfill of historic duplicates — a data operation to run once this
tool exists and has been exercised by hand, not a migration written blind.

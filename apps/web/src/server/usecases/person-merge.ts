import "server-only";
// #404 — the safe merge. Replaces the `delete from persons where id = …` that
// shipped in persons.ts: six dependent tables are `on delete cascade`, so that
// one statement destroyed the absorbed person's discipline history, stats, club
// membership, account claim and RSVPs.
//
// The absorbed row is TOMBSTONED instead (persons.merged_into, V349) and every
// prior row goes into a jsonb snapshot on person_merges, which is what makes
// the merge reversible at any time (Art. 16 rectification has no expiry) and is
// itself the audit trail. Everything happens inside one withTenant transaction:
// a partial merge is worse than none.
import type postgres from "postgres";
import { validateAssignments, type Conflict } from "@seazn/engine/scheduling";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recomputePlayerStats } from "./player-stats";
import {
  divisionFixtures,
  feedDependencies,
  loadSettings,
  peopleByEntrant,
  siblingAssignments,
  toAssignment,
  toVerifyConfig,
} from "./schedule";
import type { PersonRow } from "./persons";

type Tx = postgres.TransactionSql;

const RESULT_COLS = [
  "id",
  "full_name",
  "dob",
  "gender",
  "consent",
  "external_ref",
  "photo_path",
  "user_id",
  "created_at",
] as const;

/** Every table carrying a `person_id`. A snapshot key exists for each of them
 *  even when it is empty, so a reversal never has to guess whether "absent"
 *  means "no rows" or "not captured". */
const DEPENDENT_TABLES = [
  "entrant_members",
  "player_profiles",
  "lineups",
  "team_members",
  "player_stat_snapshots",
  "fixture_availability",
  "person_claims",
  "suspensions",
  "officials",
] as const;

interface PersonFull {
  id: string;
  org_id: string;
  user_id: string | null;
  dob: string | null;
  lane: string;
  consent: unknown;
  merged_into: string | null;
}

/** One published board the merge changed the meaning of, and what the verifier
 *  now says about it. */
export interface RevealedConflicts {
  division_id: string;
  conflicts: Conflict[];
}

export interface MergeResult {
  merge_id: string;
  survivor: PersonRow;
  /** Boards that were legal when they were published and are not any more
   *  (spec §5) — empty when the merge surfaced nothing. A REPORT, never a
   *  refusal: see `reverifyBoards`. */
  revealed: RevealedConflicts[];
}

/**
 * A merge is not a consent event and may never widen what a person agreed to,
 * so every flag resolves to `survivor && absorbed` — and an ABSENT flag is a
 * "no", matching how every read here does `coalesce((consent->>…)::boolean,
 * false)`. Non-boolean values are not consent flags; the survivor's copy wins.
 */
export function resolveConsent(survivor: unknown, absorbed: unknown): Record<string, unknown> {
  const s = (survivor ?? {}) as Record<string, unknown>;
  const a = (absorbed ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(s), ...Object.keys(a)])) {
    const sv = s[key];
    const av = a[key];
    if (typeof sv === "boolean" || typeof av === "boolean") out[key] = sv === true && av === true;
    else out[key] = sv !== undefined ? sv : av;
  }
  return out;
}

/**
 * Absorb `absorbedId` into `survivorId` (spec §4). Refusals first, then a
 * snapshot, then a per-table repoint, then the tombstone and the ledger row.
 */
export async function mergePersons(
  auth: AuthCtx,
  survivorId: string,
  absorbedId: string,
  opts: { confirmedBy: string; allowDobMismatch?: boolean },
): Promise<MergeResult> {
  if (survivorId === absorbedId) {
    throw new HttpError(422, "cannot merge a person into itself", "MERGE_SELF");
  }
  const merged = await withTenant(auth.orgId, async (tx) => {
    const [survivor] = await tx<PersonFull[]>`select * from persons where id = ${survivorId}`;
    if (!survivor) throw new HttpError(404, "person not found", "PERSON_NOT_FOUND");
    const [absorbed] = await tx<PersonFull[]>`select * from persons where id = ${absorbedId}`;
    // RLS hides other tenants' rows, so "not visible" covers both "no such
    // person" and "belongs to another org". Both are 422 on the duplicate_id
    // field, and the refusal never confirms that a foreign uuid exists.
    // Repointing across orgs would leave org_id stamped with the old tenant
    // anyway — trg_set_org (V225) is BEFORE INSERT only.
    if (!absorbed) {
      throw new HttpError(422, "duplicate person is not in this organisation", "MERGE_CROSS_ORG");
    }
    // Two distinct logins is stronger evidence of two humans than a matching
    // name. The same account twice is one human, twice — that is allowed.
    if (survivor.user_id !== null && absorbed.user_id !== null && survivor.user_id !== absorbed.user_id) {
      throw new HttpError(
        422,
        "these two records are claimed by two different accounts",
        "MERGE_TWO_ACCOUNTS",
        { user_ids: [survivor.user_id, absorbed.user_id] },
      );
    }
    if (survivor.merged_into !== null || absorbed.merged_into !== null) {
      throw new HttpError(409, "an already-merged person cannot be merged again", "MERGE_TOMBSTONE");
    }
    // A typo must stay fixable, but the tool must never nudge toward merging
    // two minors: a differing dob is merge-able only by hand-picked action.
    if (
      survivor.dob !== null &&
      absorbed.dob !== null &&
      String(survivor.dob) !== String(absorbed.dob) &&
      opts.allowDobMismatch !== true
    ) {
      throw new HttpError(422, "these two records carry different dates of birth", "MERGE_DOB_MISMATCH", {
        dob: [survivor.dob, absorbed.dob],
      });
    }

    const ids = [survivorId, absorbedId];

    // 1. Snapshot — both persons rows, every inbound tombstone about to be
    //    flattened, and every dependent row on either side. A diff is not
    //    enough: reversal has to reconstruct rows that were merged away.
    const inbound = await tx<PersonFull[]>`select * from persons where merged_into = ${absorbedId}`;
    const snapshot: Record<string, unknown[]> = { persons: [survivor, absorbed, ...inbound] };
    for (const table of DEPENDENT_TABLES) {
      const rows = await tx<Record<string, unknown>[]>`
        select * from ${tx(table)} where person_id in ${tx(ids)}`;
      snapshot[table] = [...rows];
    }

    // Divisions to refold, read BEFORE anything moves — afterwards the absorbed
    // person owns none of these rows.
    const divisions = await tx<{ division_id: string }[]>`
      select division_id from player_stat_snapshots where person_id in ${tx(ids)}
      union
      select e.division_id from entrant_members em
        join entrants e on e.id = em.entrant_id
       where em.person_id in ${tx(ids)}`;

    // 2. Consent, resolved onto the survivor. photo_path is deliberately not
    //    copied: an absorbed photo must never become reachable through a
    //    survivor whose resolved public_photo is false.
    const consent = resolveConsent(survivor.consent, absorbed.consent);

    // 3. Repoint, per §4.3.
    await repointEntrantMembers(tx, survivorId, absorbedId);
    await repointPlayerProfiles(tx, survivorId, absorbedId);
    await repointLineups(tx, survivorId, absorbedId);
    await repointTeamMembers(tx, survivorId, absorbedId);
    await repointFixtureAvailability(tx, survivorId, absorbedId);
    await repointPersonClaims(tx, survivorId, absorbedId);
    await repointSuspensions(tx, survivorId, absorbedId);
    // Officials mint unconditionally and cannot dedupe (#402), so a cross-lane
    // pair is never a duplicate and its officiating rows must not move.
    if (survivor.lane === "official" && absorbed.lane === "official") {
      await tx`update officials set person_id = ${survivorId} where person_id = ${absorbedId}`;
    }
    // 4. Flatten inbound tombstones, so merged_into always names a LIVE person
    //    and every read stays one check.
    await tx`update persons set merged_into = ${survivorId} where merged_into = ${absorbedId}`;
    // 5. Tombstone. Never delete.
    await tx`update persons set merged_into = ${survivorId} where id = ${absorbedId}`;

    // 6. Stats are aggregates: picking one row silently halves a season. Drop
    //    both and refold the division from its ledger. This runs AFTER the
    //    tombstone is written, not before: the fold reads person ids out of the
    //    score events and relabels them through `persons.merged_into`
    //    (player-stats.ts:85). Refolding first builds that map while the
    //    tombstone is still absent, so the absorbed person's own goals stay
    //    keyed to a row no roster read can see and the survivor never inherits
    //    them — invisible unless BOTH sides carry events.
    await tx`delete from player_stat_snapshots where person_id in ${tx(ids)}`;
    for (const { division_id } of divisions) await recomputePlayerStats(tx, division_id);

    const [updated] = await tx<PersonRow[]>`
      update persons set consent = ${tx.json(consent as never)}
      where id = ${survivorId} returning ${tx(RESULT_COLS)}`;

    // 7. The ledger row — audit trail and undo record in one.
    const [merge] = await tx<{ id: string }[]>`
      insert into person_merges (org_id, survivor_id, absorbed_id, actor_user_id, snapshot)
      values (${auth.orgId}, ${survivorId}, ${absorbedId}, ${opts.confirmedBy},
              ${tx.json(snapshot as never)})
      returning id`;

    return { merge_id: merge!.id, survivor: updated! };
  });

  // 8. Re-verify, AFTER the write has committed. Two people on two courts at
  //    once was a legal board a moment ago; one person on two courts is not, and
  //    the organiser is the only one who can move a card. `.catch` mirrors the
  //    post-commit side effects in schedule.ts (`afterScheduleWrite`, the
  //    official-notice emails): a report that fails may not unmake a merge that
  //    succeeded, and the merge has no transaction left to roll back anyway.
  return { ...merged, revealed: await reverifyBoards(auth, survivorId).catch(() => []) };
}

/**
 * Every PUBLISHED board the survivor now appears in, re-verified (spec §5).
 *
 * Reported, never enforced. Per the W4 delta rule (#399) the write gate refuses
 * only what a change INTRODUCED, and this change introduces conflicts on purpose
 * — refusing the merge would leave the duplicate in place and the board just as
 * wrong, with nothing the organiser could do about either. So the merge is done
 * by the time this runs, and it runs in its own transaction.
 *
 * `status <> 'setup'` is what "published" means here: `publishSchedule` is the
 * only thing that moves a division off `setup`, so a board still being drafted
 * has no audience to disappoint and is left out.
 *
 * The whole assembly — settings, fixtures, people, siblings — is the one
 * `validateSchedule` uses, deliberately: a merge must not invent a second
 * opinion about what makes a board wrong.
 */
async function reverifyBoards(auth: AuthCtx, survivorId: string): Promise<RevealedConflicts[]> {
  return withTenant(auth.orgId, async (tx) => {
    const boards = await tx<{ id: string; competition_id: string }[]>`
      select distinct d.id, d.competition_id
        from divisions d
        join entrants e on e.division_id = d.id
        join entrant_members em on em.entrant_id = e.id
       where em.person_id = ${survivorId} and d.status <> 'setup'
       order by d.id`;
    const out: RevealedConflicts[] = [];
    for (const board of boards) {
      const settings = await loadSettings(tx, board.id);
      const all = await divisionFixtures(tx, board.id);
      const entrantIds = [
        ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const people = await peopleByEntrant(tx, entrantIds);
      const assignments = all
        .filter((f) => f.scheduled_at !== null && f.court_label !== null)
        .map((f) => toAssignment(f, settings.config.matchMinutes, people));
      if (assignments.length === 0) continue;
      const siblings = await siblingAssignments(
        tx,
        board.id,
        board.competition_id,
        settings.config.matchMinutes,
      );
      const conflicts = validateAssignments(
        assignments,
        toVerifyConfig(settings, all, 0),
        siblings,
        feedDependencies(all),
      );
      if (conflicts.length > 0) out.push({ division_id: board.id, conflicts });
    }
    return out;
  });
}

interface MergeLedgerRow {
  survivor_id: string;
  absorbed_id: string;
  snapshot: Record<string, Record<string, unknown>[]>;
  reversed_at: Date | null;
}

/**
 * Undo a merge (spec §4.4). The undo window is unbounded — Art. 16
 * rectification has no expiry and a duplicate is often noticed a season later —
 * so this replays the snapshot backwards rather than recomputing an inverse:
 * both `persons` rows (including the absorbed person's OWN consent flags, so
 * the restrictive resolution applied to the survivor is undone too), every
 * dependent row that moved or was resolved away, and the tombstones that were
 * flattened onto the survivor.
 *
 * Only SNAPSHOTTED rows move. A row created after the merge was never captured,
 * belongs to the survivor by the organiser's own later action, and stays there.
 *
 * All of it in one `withTenant` transaction: a half-reversed merge is worse than
 * no reversal. The ledger row is kept and stamped, never deleted — it is the
 * audit trail (#403 R2/R3), and `person_merges_absorbed_live_uq` is partial on
 * `reversed_at is null`, so stamping it is also what frees the pair to be merged
 * again.
 */
export async function reverseMerge(
  auth: AuthCtx,
  mergeId: string,
  opts: { confirmedBy: string },
): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    // `for update` — two concurrent reversals of one merge would otherwise both
    // pass the guard and replay the snapshot twice.
    const [merge] = await tx<MergeLedgerRow[]>`
      select survivor_id, absorbed_id, snapshot, reversed_at
        from person_merges where id = ${mergeId} for update`;
    // RLS hides other tenants' rows, so "not visible" covers both "no such
    // merge" and "belongs to another org".
    if (!merge) throw new HttpError(404, "merge not found", "MERGE_NOT_FOUND");
    if (merge.reversed_at !== null) {
      throw new HttpError(409, "this merge has already been reversed", "MERGE_ALREADY_REVERSED");
    }

    const ids = [merge.survivor_id, merge.absorbed_id];
    const snapshot = merge.snapshot ?? {};
    const rowsOf = (table: string): Record<string, unknown>[] => snapshot[table] ?? [];

    // 1. The persons rows. A merge writes exactly two things to a persons row —
    //    `consent` on the survivor and `merged_into` on the absorbed row plus
    //    every tombstone it flattened — so those two are what comes back.
    //    Restoring the whole row would clobber an edit the organiser made to a
    //    live person after the merge, which the merge never touched.
    for (const row of rowsOf("persons")) {
      await tx`
        update persons
           set consent = ${tx.json((row.consent ?? {}) as never)},
               merged_into = ${(row.merged_into as string | null) ?? null}
         where id = ${row.id as string}`;
    }

    // 2. The dependent rows. For each table the snapshot's rows are deleted from
    //    their current owner and re-inserted verbatim through
    //    jsonb_populate_recordset, which round-trips jsonb, arrays and
    //    timestamps by the table's own column types. The delete is scoped to the
    //    SLOTS the snapshot occupies (the row's key minus person_id), never to
    //    "everything these two people own" — that is what leaves post-merge rows
    //    alone.
    await restoreSlots(tx, "entrant_members", ids, rowsOf("entrant_members"), "entrant_id");
    await restoreSlots(tx, "player_profiles", ids, rowsOf("player_profiles"), "sport_key");
    await restoreSlots(tx, "team_members", ids, rowsOf("team_members"), "team_id");
    await restoreSlots(tx, "fixture_availability", ids, rowsOf("fixture_availability"), "fixture_id");
    await restoreSlots(tx, "suspensions", ids, rowsOf("suspensions"), "id");
    // lineups is the one two-column slot: (fixture_id, entrant_id). The keys are
    // compared as one concatenated text value rather than a row constructor —
    // these sets are a handful of rows, and it keeps the statement literal.
    const lineups = rowsOf("lineups");
    if (lineups.length > 0) {
      const slots = [...new Set(lineups.map((r) => `${r.fixture_id as string}:${r.entrant_id as string}`))];
      await tx`
        delete from lineups
         where person_id in ${tx(ids)}
           and (fixture_id::text || ':' || entrant_id::text) in ${tx(slots)}`;
      await reinsertSnapshot(tx, "lineups", lineups);
    }

    // person_claims and officials are never deleted by a merge, only updated, so
    // they are restored in place. That is not tidiness: `person_claims` carries
    // no DELETE grant to app_user (V276:29), and deleting an `officials` row
    // would cascade its fixture assignments away (V243:24).
    const claims = rowsOf("person_claims");
    if (claims.length > 0) {
      await tx`
        update person_claims t
           set person_id = s.person_id, revoked_at = s.revoked_at
          from jsonb_populate_recordset(null::person_claims, ${tx.json(claims as never)}::jsonb) s
         where t.id = s.id`;
    }
    const officials = rowsOf("officials");
    if (officials.length > 0) {
      await tx`
        update officials t
           set person_id = s.person_id
          from jsonb_populate_recordset(null::officials, ${tx.json(officials as never)}::jsonb) s
         where t.id = s.id`;
    }

    // 3. Stats are a disposable cache over the ledger, so they are re-derived
    //    rather than replayed — replaying would restore whatever staleness the
    //    cache happened to hold at merge time. This runs after step 1 has
    //    cleared `merged_into`: the fold relabels event person ids through it
    //    (player-stats.ts:85), so a clear pointer is exactly what keys the rows
    //    back to the person who earned them.
    const divisions = await tx<{ division_id: string }[]>`
      select division_id from player_stat_snapshots where person_id in ${tx(ids)}
      union
      select e.division_id from entrant_members em
        join entrants e on e.id = em.entrant_id
       where em.person_id in ${tx(ids)}`;
    await tx`delete from player_stat_snapshots where person_id in ${tx(ids)}`;
    for (const { division_id } of divisions) await recomputePlayerStats(tx, division_id);

    // 4. Stamp. Kept, never deleted.
    await tx`
      update person_merges set reversed_at = now(), reversed_by = ${opts.confirmedBy}
       where id = ${mergeId}`;
  });
}

/**
 * Put `rows` back into `table`, replacing whatever now sits in the slots they
 * occupied. `keyCol` is the row's identity minus `person_id`: the composite-PK
 * tables key on the other half of their PK, the surrogate-PK tables on `id`.
 * Scoping the delete to those slots is what makes a reversal exact — a row
 * created on the survivor after the merge sits in a slot no snapshot row names,
 * so it is never touched.
 */
async function restoreSlots(
  tx: Tx,
  table: string,
  ids: string[],
  rows: Record<string, unknown>[],
  keyCol: string,
): Promise<void> {
  if (rows.length === 0) return;
  const keys = [...new Set(rows.map((r) => r[keyCol] as string))];
  await tx`
    delete from ${tx(table)}
     where person_id in ${tx(ids)} and ${tx(keyCol)} in ${tx(keys)}`;
  await reinsertSnapshot(tx, table, rows);
}

/** Snapshot rows go back through `jsonb_populate_recordset`, which rebuilds them
 *  by the table's OWN column types — jsonb columns stay structural, `uuid[]`
 *  stays an array and a timestamptz parses back out of its ISO text. Hand-listing
 *  columns here would silently drop any added later. */
async function reinsertSnapshot(tx: Tx, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  await tx`
    insert into ${tx(table)}
    select * from jsonb_populate_recordset(null::${tx(table)}, ${tx.json(rows as never)}::jsonb)`;
}

/** Same human on the same team — nothing they held may silently vanish, so a
 *  collision resolves field-wise with the strongest value winning. */
async function repointEntrantMembers(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    update entrant_members s
       set is_captain = s.is_captain or a.is_captain,
           squad_number = coalesce(s.squad_number, a.squad_number),
           default_position_key = coalesce(s.default_position_key, a.default_position_key),
           roles = (select coalesce(jsonb_agg(distinct r.value), '[]'::jsonb)
                      from jsonb_array_elements(s.roles || a.roles) r)
      from entrant_members a
     where s.person_id = ${survivorId} and a.person_id = ${absorbedId}
       and a.entrant_id = s.entrant_id`;
  await tx`
    delete from entrant_members
     where person_id = ${absorbedId}
       and entrant_id in (select entrant_id from entrant_members where person_id = ${survivorId})`;
  await tx`update entrant_members set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

/** The survivor's profile wins per sport; the absorbed one lives on in the
 *  snapshot. */
async function repointPlayerProfiles(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    delete from player_profiles
     where person_id = ${absorbedId}
       and sport_key in (select sport_key from player_profiles where person_id = ${survivorId})`;
  await tx`update player_profiles set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

/** A historical lineup records who played, and one human cannot appear twice in
 *  it — the survivor's row is kept. */
async function repointLineups(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    delete from lineups
     where person_id = ${absorbedId}
       and (fixture_id, entrant_id) in
           (select fixture_id, entrant_id from lineups where person_id = ${survivorId})`;
  await tx`update lineups set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

async function repointTeamMembers(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    delete from team_members
     where person_id = ${absorbedId}
       and team_id in (select team_id from team_members where person_id = ${survivorId})`;
  await tx`update team_members set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

/** Most recent response wins: an RSVP is a statement about availability now,
 *  and the older of the two has been superseded. */
async function repointFixtureAvailability(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    delete from fixture_availability a
     using fixture_availability s
     where a.person_id = ${absorbedId} and s.person_id = ${survivorId}
       and s.fixture_id = a.fixture_id and s.updated_at >= a.updated_at`;
  await tx`
    delete from fixture_availability s
     using fixture_availability a
     where s.person_id = ${survivorId} and a.person_id = ${absorbedId}
       and s.fixture_id = a.fixture_id and a.updated_at > s.updated_at`;
  await tx`update fixture_availability set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

/** The survivor's open claim is kept and the absorbed one yields to it. Claims
 *  are never deleted — the token has to stay accounted for. person_claims has
 *  no reason column, so the reason is the person_merges row that revoked it. */
async function repointPersonClaims(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    update person_claims
       set revoked_at = now()
     where person_id = ${absorbedId} and claimed_at is null and revoked_at is null
       and exists (select 1 from person_claims s
                    where s.person_id = ${survivorId}
                      and s.claimed_at is null and s.revoked_at is null)`;
  await tx`update person_claims set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

/** All rows move. A collision means the same auto rule fired for both records
 *  — keep the earlier row, the other stays in the snapshot. The predicates
 *  mirror suspensions_auto_once / suspensions_report_once, including the `=` on
 *  rule_key and bucket: those indexes are NULLS DISTINCT, so a null key never
 *  collides and `is not distinct from` would drop a row the index allows. */
async function repointSuspensions(tx: Tx, survivorId: string, absorbedId: string): Promise<void> {
  await tx`
    delete from suspensions a
     using suspensions s
     where a.person_id = ${absorbedId} and s.person_id = ${survivorId}
       and a.division_id = s.division_id and a.rule_key = s.rule_key and a.bucket = s.bucket
       and ((a.source in ('auto_accumulation','auto_dismissal')
             and s.source in ('auto_accumulation','auto_dismissal'))
            or (a.source = 'report' and s.source = 'report'))
       and s.created_at <= a.created_at`;
  await tx`
    delete from suspensions s
     using suspensions a
     where s.person_id = ${survivorId} and a.person_id = ${absorbedId}
       and a.division_id = s.division_id and a.rule_key = s.rule_key and a.bucket = s.bucket
       and ((a.source in ('auto_accumulation','auto_dismissal')
             and s.source in ('auto_accumulation','auto_dismissal'))
            or (a.source = 'report' and s.source = 'report'))
       and a.created_at < s.created_at`;
  await tx`update suspensions set person_id = ${survivorId} where person_id = ${absorbedId}`;
}

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
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recomputePlayerStats } from "./player-stats";
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

export interface MergeResult {
  merge_id: string;
  survivor: PersonRow;
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
  return withTenant(auth.orgId, async (tx) => {
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
    // Stats are aggregates: picking one row silently halves a season. Drop both
    // and refold the division from its ledger.
    await tx`delete from player_stat_snapshots where person_id in ${tx(ids)}`;
    for (const { division_id } of divisions) await recomputePlayerStats(tx, division_id);

    // 4. Flatten inbound tombstones, so merged_into always names a LIVE person
    //    and every read stays one check.
    await tx`update persons set merged_into = ${survivorId} where merged_into = ${absorbedId}`;
    // 5. Tombstone. Never delete.
    await tx`update persons set merged_into = ${survivorId} where id = ${absorbedId}`;

    const [updated] = await tx<PersonRow[]>`
      update persons set consent = ${tx.json(consent as never)}
      where id = ${survivorId} returning ${tx(RESULT_COLS)}`;

    // 6. The ledger row — audit trail and undo record in one.
    const [merge] = await tx<{ id: string }[]>`
      insert into person_merges (org_id, survivor_id, absorbed_id, actor_user_id, snapshot)
      values (${auth.orgId}, ${survivorId}, ${absorbedId}, ${opts.confirmedBy},
              ${tx.json(snapshot as never)})
      returning id`;

    return { merge_id: merge!.id, survivor: updated! };
  });
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

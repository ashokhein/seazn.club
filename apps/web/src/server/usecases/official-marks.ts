import "server-only";
// SPEC-3 / PROMPT-80 — organiser marks (Pro, org-private). An organiser rates
// an accepted assignment 1..5 after the fixture is decided, with an optional
// comment. Written on the tenant rail (RLS scopes the org); official_id and
// fixture_id are stamped from the assignment row server-side, never the body.
// The org sees its own avg/count + recent comments; the official sees only a
// global running average, and only once >= 3 marks exist (D4) — never any
// per-mark detail, comment, or org breakdown.
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";

type Tx = postgres.TransactionSql;
// The official-facing global average straddles every org, so it reads through
// the superuser connection (same reasoning as me-officiating.ts): withTenant
// scopes to one org and this aggregate is cross-org by design.
const superuser = sql as unknown as Tx;

const FEATURE = "officials.marks";

// A mark binds to the performance, not the result — decided/finalized only.
// Marks on later-voided fixtures still count (SPEC-3): voiding a result never
// voids the performance the mark rated.
const RATEABLE = ["decided", "finalized"] as const;

export interface MarkSummary {
  average: number | null;
  count: number;
  recent: { mark: number; comment: string | null; fixtureLabel: string; createdAt: string }[];
}

interface AssignmentRow {
  official_id: string;
  fixture_id: string;
  response: string;
  fixture_status: string;
}

/** Load the assignment behind a fixtureOfficialId within the org and assert the
 *  mark window. 404 when the assignment is not in this org; 403 when the
 *  window is closed (response not accepted, or fixture not yet decided). */
async function rateableAssignment(tx: Tx, orgId: string, foId: string): Promise<AssignmentRow> {
  const [row] = await tx<AssignmentRow[]>`
    select fo.official_id, fo.fixture_id, fo.response, f.status as fixture_status
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    where fo.id = ${foId} and fo.org_id = ${orgId}`;
  if (!row) throw new HttpError(404, "assignment not found");
  if (row.response !== "accepted") {
    throw new HttpError(403, "Only an accepted assignment can be rated", "MARK_WINDOW_CLOSED");
  }
  if (!RATEABLE.includes(row.fixture_status as (typeof RATEABLE)[number])) {
    throw new HttpError(403, "Rate an official once the fixture is decided", "MARK_WINDOW_CLOSED");
  }
  return row;
}

/** Upsert the 1..5 mark for an assignment (one per assignment, editable
 *  forever — leagues correct marks). official_id/fixture_id are taken from the
 *  assignment, never the caller. */
export async function putMark(
  auth: AuthCtx,
  fixtureOfficialId: string,
  input: { mark: number; comment?: string },
): Promise<void> {
  await requireFeature(auth.orgId, FEATURE);
  await withTenant(auth.orgId, async (tx) => {
    const a = await rateableAssignment(tx, auth.orgId, fixtureOfficialId);
    await tx`
      insert into official_marks
        (org_id, fixture_official_id, official_id, fixture_id, mark, comment, created_by)
      values (${auth.orgId}, ${fixtureOfficialId}, ${a.official_id}, ${a.fixture_id},
              ${input.mark}, ${input.comment?.trim() || null}, ${auth.userId})
      on conflict (fixture_official_id) do update
        set mark = excluded.mark, comment = excluded.comment,
            created_by = excluded.created_by, updated_at = now()`;
  });
}

/** Clear the mark for an assignment (idempotent). */
export async function deleteMark(auth: AuthCtx, fixtureOfficialId: string): Promise<void> {
  await requireFeature(auth.orgId, FEATURE);
  await withTenant(auth.orgId, (tx) =>
    tx`delete from official_marks where fixture_official_id = ${fixtureOfficialId}`);
}

/** Org-scoped avg/count + the last 5 comments for the org official profile. */
export async function orgMarksSummary(auth: AuthCtx, officialId: string): Promise<MarkSummary> {
  await requireFeature(auth.orgId, FEATURE);
  return withTenant(auth.orgId, async (tx) => {
    const [agg] = await tx<{ average: number | null; count: number }[]>`
      select avg(mark)::float as average, count(*)::int as count
      from official_marks where official_id = ${officialId}`;
    const recent = await tx<
      { mark: number; comment: string | null; fixture_label: string; created_at: Date }[]
    >`
      select om.mark, om.comment,
             coalesce(h.display_name, 'TBD') || ' vs ' || coalesce(a.display_name, 'TBD') as fixture_label,
             om.created_at
      from official_marks om
      join fixtures f on f.id = om.fixture_id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
      where om.official_id = ${officialId}
      order by om.created_at desc, om.id
      limit 5`;
    const count = agg?.count ?? 0;
    return {
      average: count > 0 ? (agg!.average ?? null) : null,
      count,
      recent: recent.map((r) => ({
        mark: r.mark,
        comment: r.comment,
        fixtureLabel: r.fixture_label,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });
}

/** Official-facing GLOBAL average across every org (D4). Null until at least 3
 *  marks exist — small-sample deanonymisation guard. Superuser read: the
 *  official is not an org member, and this aggregate crosses orgs by design. */
export async function myMarksAverage(
  userId: string,
): Promise<{ average: number; count: number } | null> {
  const [agg] = await superuser<{ average: number | null; count: number }[]>`
    select avg(om.mark)::float as average, count(*)::int as count
    from official_marks om
    join officials o on o.id = om.official_id
    join persons p on p.id = o.person_id
    where p.user_id = ${userId}`;
  const count = agg?.count ?? 0;
  if (count < 3 || agg?.average == null) return null;
  return { average: agg.average, count };
}

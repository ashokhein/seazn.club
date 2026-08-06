import "server-only";
// Staff-only division actions (V354).
//
// Reads and writes with the plain `sql` proxy, not `withTenant`: a staff action
// crosses orgs by definition and `staff_audit_log` is not an org-scoped table.
import { logStaffAction } from "@/lib/admin";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

interface SlotWaiverTarget {
  org_id: string;
  competition_id: string;
  name: string;
}

/**
 * "This division is still holding a `divisions.per_competition.max` slot" —
 * the ONE definition, as a SQL fragment both readers below interpolate.
 *
 * It is deliberately not restated in prose anywhere: `division_has_results`
 * (V354, widened by V355) is the shared results predicate for exactly this
 * reason, and a forked copy of one rule is this repo's recurring defect. The
 * three clauses are the same three `createDivision` counts by
 * (`divisions.ts`): archived, uncharged-so-far, and played.
 *
 * Columns are qualified with the table name rather than an alias so the same
 * fragment drops into an `update divisions … where` (where the target table is
 * the only legal qualifier) and into the join below.
 *
 * A function, not a module-level constant: a postgres.js fragment is a Query
 * object and is consumed when it is rendered, so it must be built per use.
 */
function consumesSlot() {
  return sql`divisions.archived_at is not null
             and divisions.slot_waived_at is null
             and division_has_results(divisions.id)`;
}

/**
 * Staff-only: clear a division's quota-slot consumption (V354).
 *
 * A division's `divisions.per_competition.max` slot is spent by RECORDED
 * RESULTS, and the rule has NO timer by design — any window long enough to
 * close the archive-and-recreate loop is short enough to punish an honest
 * mistake. So an org that burns a slot by genuine accident (one stray recorded
 * result on a division it then archives) gets a SUPPORT PATH rather than a
 * loophole, and `createDivision`/`restoreDivision` stop counting the division
 * the moment `slot_waived_at` is set.
 *
 * Audited, because it moves an entitlement boundary for a paying customer. The
 * audit target is the ORG — that is whose boundary moved, and it is what
 * `/admin/orgs/[id]`'s staff-history panel reads — with the division carried in
 * `detail`. `logStaffAction`'s `targetType` union has no `"division"` member
 * and this write is not inside a transaction, so the helper is called as-is
 * rather than mirrored inline.
 *
 * THE STAFF ASSERTION LIVES HERE, not only at the route. `requireStaff()` reads
 * the SESSION, so it cannot judge an arbitrary actor id and its refusal is a
 * 401 — but the caller here is authenticated and being refused, which is a 403.
 * The route therefore does NOT re-check: this is the single gate, and it runs
 * before anything is written.
 *
 * 409 (`DIVISION_SLOT_NOT_CONSUMED`) when the division is not actually holding
 * a slot — live, archived-but-never-played, or ALREADY waived. All three fall
 * out of the one `consumesSlot()` predicate, and all three would otherwise
 * "succeed": both columns written and an audit row logged that records nothing
 * real. The already-waived case is deliberately NOT idempotent success — the
 * slot is already back, so the caller is acting on a stale page and should be
 * told, not silently restamped over the first waiver's actor.
 *
 * The predicate rides on the UPDATE rather than a preceding SELECT, so two
 * staffers on the same stale page cannot both pass a check and both write.
 */
export async function waiveDivisionSlot(actorId: string, divisionId: string): Promise<void> {
  const [actor] = await sql<{ is_staff: boolean }[]>`
    select is_staff from users where id = ${actorId} and deleted_at is null`;
  if (!actor?.is_staff) throw new HttpError(403, "Staff access required");

  const [division] = await sql<SlotWaiverTarget[]>`
    select org_id, competition_id, name from divisions where id = ${divisionId}`;
  if (!division) throw new HttpError(404, "division not found");

  const [waived] = await sql<{ id: string }[]>`
    update divisions
       set slot_waived_at = now(), slot_waived_by = ${actorId}
     where divisions.id = ${divisionId}
       and ${consumesSlot()}
    returning divisions.id`;
  if (!waived) {
    throw new HttpError(
      409,
      "That division is not using a quota slot — it may already have been waived. Refresh and check.",
      "DIVISION_SLOT_NOT_CONSUMED",
    );
  }

  await logStaffAction(actorId, "division_slot_waived", "org", division.org_id, {
    division_id: divisionId,
    division_name: division.name,
    competition_id: division.competition_id,
  });
}

export interface SlotConsumingDivision {
  id: string;
  name: string;
  competitionId: string;
  competitionName: string;
  archivedAt: string;
}

/**
 * The archived divisions of one org that are still holding a quota slot — the
 * exact population `createDivision` counts beyond `archived_at is null`, and
 * the only place the waiver means anything.
 *
 * `/admin` offers the button from this list rather than beside every division:
 * a control that silently no-ops on the 99% of divisions that were never
 * charged is worse than no control.
 */
export async function slotConsumingDivisions(orgId: string): Promise<SlotConsumingDivision[]> {
  return sql<SlotConsumingDivision[]>`
    select divisions.id, divisions.name, divisions.competition_id as "competitionId",
           c.name as "competitionName", divisions.archived_at as "archivedAt"
    from divisions
    join competitions c on c.id = divisions.competition_id
    where divisions.org_id = ${orgId}
      and ${consumesSlot()}
    order by divisions.archived_at desc
    limit 50`;
}

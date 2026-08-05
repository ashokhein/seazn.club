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
 */
export async function waiveDivisionSlot(actorId: string, divisionId: string): Promise<void> {
  const [actor] = await sql<{ is_staff: boolean }[]>`
    select is_staff from users where id = ${actorId} and deleted_at is null`;
  if (!actor?.is_staff) throw new HttpError(403, "Staff access required");

  const [division] = await sql<SlotWaiverTarget[]>`
    select org_id, competition_id, name from divisions where id = ${divisionId}`;
  if (!division) throw new HttpError(404, "division not found");

  await sql`
    update divisions
       set slot_waived_at = now(), slot_waived_by = ${actorId}
     where id = ${divisionId}`;

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
    select d.id, d.name, d.competition_id as "competitionId",
           c.name as "competitionName", d.archived_at as "archivedAt"
    from divisions d
    join competitions c on c.id = d.competition_id
    where d.org_id = ${orgId}
      and d.archived_at is not null
      and d.slot_waived_at is null
      and division_has_results(d.id)
    order by d.archived_at desc
    limit 50`;
}

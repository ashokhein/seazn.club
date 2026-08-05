import "server-only";
// Read-side disclosure of the V354 quota-slot rule (#376 part D, task 8).
//
// The rule itself lives in `divisions.ts` (createDivision / restoreDivision):
// a division counts against `divisions.per_competition.max` while it is
// visible, AND after it is archived if it has recorded results and staff have
// not waived the slot. That rule works. What it never did was SAY so — an org
// archived a played division, saw one division on screen, and then met a
// paywall with no visible cause.
//
// These two reads exist so the console can explain itself BEFORE the archive
// and AFTER the refusal. Both ask the database the same question the quota
// count asks — `division_has_results(...)`, the SQL function — rather than
// re-deriving "has results" from a status list in TypeScript. That matters
// beyond tidiness: V355 widens the function to count an abandoned fixture
// carrying a real verdict, and a TypeScript copy of the predicate would start
// disagreeing with the charge the moment it lands, which is the worst possible
// shape for this feature (a warning that says the slot is free while the quota
// keeps charging for it).
import { withTenant } from "@/lib/db";
import { withinLimit } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";

const DIVISION_QUOTA_KEY = "divisions.per_competition.max";

/**
 * Does this division hold results — i.e. would archiving it keep its quota
 * slot spent?
 *
 * `slot_waived_at` is deliberately part of the answer. The question the danger
 * zone asks is not "has anything been played here" but "will archiving this
 * cost me a slot", and a staff waiver is exactly the state where those two
 * diverge: the fixtures are still there, the charge is not. Warning a
 * supported org that their slot will not come back, after support has already
 * given it back, is the same class of lie this task exists to remove.
 */
export async function divisionConsumesSlotOnArchive(
  auth: AuthCtx,
  divisionId: string,
): Promise<boolean> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ consumes: boolean }[]>`
      select (division_has_results(d.id) and d.slot_waived_at is null) as consumes
      from divisions d where d.id = ${divisionId}`;
    return row?.consumes ?? false;
  });
}

/**
 * How many ARCHIVED divisions of this competition are still holding a quota
 * slot — the invisible half of the count `createDivision` refuses on.
 *
 * A count rather than a boolean because the caller decides whether zero means
 * "say nothing": the explanation is owed only when there is something
 * invisible to explain, and a paywall that volunteers "archived divisions
 * count too" to an org that has archived nothing is noise on a page where the
 * reader is already frustrated.
 */
export async function archivedSlotHoldersInCompetition(
  auth: AuthCtx,
  competitionId: string,
): Promise<number> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${competitionId}
        and d.archived_at is not null
        and division_has_results(d.id)
        and d.slot_waived_at is null`;
    return row?.n ?? 0;
  });
}

/**
 * Are the invisible archived slots what tipped this competition over its
 * division limit — i.e. would releasing them let the refused create or restore
 * through?
 *
 * A non-zero holder count is NOT the same question, and shipping it as if it
 * were is how an explanation becomes a wrong answer: at a cap of 4 with 4
 * VISIBLE divisions and 1 archived holder, the refusal stands whatever happens
 * to the archived one, and telling the reader to go looking at archived
 * divisions sends them to fix something that is not the cause. So the count is
 * only half of it — the other half is whether the create would have fitted
 * WITHOUT them, which is `withinLimit(visible + 1)`: the same helper, the same
 * feature key and the same "+1 for the row being added" that `createDivision`
 * and `restoreDivision` charge on, so this cannot drift away from the refusal
 * it is explaining. (A restore adds one visible division too, which is why one
 * predicate serves both surfaces.)
 *
 * Short-circuits on the count, so the ordinary competition — nothing archived,
 * nothing to explain — still costs exactly one query.
 */
export async function archivedSlotsExplainRefusal(
  auth: AuthCtx,
  competitionId: string,
): Promise<boolean> {
  const holders = await archivedSlotHoldersInCompetition(auth, competitionId);
  if (holders === 0) return false;
  const visible = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${competitionId} and d.archived_at is null`;
    return row?.n ?? 0;
  });
  const quota = await withinLimit(auth.orgId, DIVISION_QUOTA_KEY, visible + 1, competitionId);
  return quota.ok;
}

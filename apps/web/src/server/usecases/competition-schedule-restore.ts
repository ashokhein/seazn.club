import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { lockDivisions } from "./competition-schedule-apply";
import { JOINT_APPLY_EVENT } from "./competition-schedule-ai";
import { restoreCheckpoint } from "./history";

export interface CompetitionRestoreOut {
  restored: { division_id: string; watermark: number; steps: number }[];
  failed: { division_id: string; reason: string }[];
  ok: boolean;
}

/**
 * POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *
 * `applyCompetitionSchedule` writes every selected division in ONE transaction.
 * Undoing it used to be N independent restores driven by a client loop, so the
 * board could never be left half-written by an apply but could be left
 * half-restored by an undo — and a closed browser tab was enough to do it.
 *
 * NOT one transaction, deliberately. `restoreCheckpoint` rewinds by appending
 * inverse events, each its own single-writer transaction (`history.ts`), and
 * that is what makes it concurrency-safe; wrapping N divisions x up to 500
 * appends in one transaction would hold N advisory locks for the whole rewind.
 * What this endpoint adds instead: every division's lock is taken up front in
 * sorted order (the apply's own deadlock guard), the loop runs on the server so
 * it cannot be abandoned mid-way by a client, and a failure is REPORTED per
 * division rather than left for the caller to discover.
 *
 * The division set is validated against the apply event rather than trusted:
 * the caller supplies the checkpoint anchors (only the client holds them — the
 * event carries `division_ids` and nothing else), and the set must match the
 * event's list exactly. A subset is a 422, not a partial restore.
 */
export async function restoreCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { checkpoints: { division_id: string; checkpoint_id: string }[]; confirm: true },
): Promise<CompetitionRestoreOut> {
  if (!input.confirm) throw new HttpError(422, "restore requires confirm: true");

  const applied = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ payload: { division_ids?: string[] } }[]>`
      select payload from competition_events
       where competition_id = ${competitionId} and org_id = ${auth.orgId}
         and type = ${JOINT_APPLY_EVENT}
       order by created_at desc
       limit 1`;
    if (!row) throw new HttpError(404, "no joint apply to restore");
    return row.payload.division_ids ?? [];
  });

  const asked = input.checkpoints.map((c) => c.division_id);
  if (new Set(asked).size !== asked.length) throw new HttpError(422, "a division was named twice");
  const askedSorted = [...asked].sort();
  const appliedSorted = [...applied].sort();
  const same =
    askedSorted.length === appliedSorted.length &&
    askedSorted.every((id, i) => id === appliedSorted[i]);
  if (!same) {
    throw new HttpError(422, "a joint restore must name exactly the divisions the apply wrote");
  }

  // Locks first, in sorted order — the same deadlock guard the apply uses, so a
  // joint restore and a concurrent joint apply over an overlapping set cannot
  // grab each other's divisions in opposite orders. `pg_advisory_xact_lock` is
  // released when its transaction ends, so this is a serialisation point and an
  // ordering discipline, not a lock held across the rewinds below — holding it
  // there is the "fully atomic" option the owner declined (see the header).
  await withTenant(auth.orgId, async (tx) => {
    await lockDivisions(tx, asked);
  });

  const restored: CompetitionRestoreOut["restored"] = [];
  const failed: CompetitionRestoreOut["failed"] = [];
  for (const c of [...input.checkpoints].sort((a, b) =>
    a.division_id.localeCompare(b.division_id),
  )) {
    try {
      const out = await restoreCheckpoint(auth, c.division_id, c.checkpoint_id, true);
      restored.push({ division_id: c.division_id, watermark: out.watermark, steps: out.steps });
    } catch (err) {
      // Kept going on purpose: stopping at the first refusal would leave MORE
      // divisions carrying the AI board than carrying on does, and the caller
      // needs to know WHICH divisions still do.
      failed.push({
        division_id: c.division_id,
        reason: err instanceof Error ? err.message : "restore failed",
      });
    }
  }
  return { restored, failed, ok: failed.length === 0 };
}

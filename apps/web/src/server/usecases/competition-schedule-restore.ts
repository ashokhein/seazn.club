import { SessionLockTimeoutError, withSessionLocks, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { JOINT_APPLY_EVENT } from "./competition-schedule-ai";
import { restoreCheckpoint } from "./history";

/** Matched to `applyCompetitionSchedule`'s `set local lock_timeout = '5s'`: the
 *  two paths queue on the SAME key, so a caller cannot tell which side it lost
 *  to and should not get two different answers about how long it waited. */
const RESTORE_LOCK_TIMEOUT_MS = 5_000;

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
 * What this endpoint adds instead: the whole rewind runs under ONE
 * competition-scoped lock (below), the loop runs on the server so it cannot be
 * abandoned mid-way by a client, and a failure is REPORTED per division rather
 * than left for the caller to discover.
 *
 * The division set is validated against the apply event rather than trusted:
 * the caller supplies the checkpoint anchors (only the client holds them — the
 * event carries `division_ids` and nothing else), and the set must match the
 * event's list exactly. A subset is a 422, not a partial restore. That check
 * runs UNDER the lock below, so it and the rewind see the same world.
 */
export async function restoreCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { checkpoints: { division_id: string; checkpoint_id: string }[]; confirm: true },
): Promise<CompetitionRestoreOut> {
  // Body checks only, before the lock: rejecting a malformed request needs no
  // database and no exclusion, and taking a lock to do it would make a
  // double-clicked typo queue behind a rewind. Everything that reads state
  // belongs below.
  if (!input.confirm) throw new HttpError(422, "restore requires confirm: true");
  const asked = input.checkpoints.map((c) => c.division_id);
  if (new Set(asked).size !== asked.length) throw new HttpError(422, "a division was named twice");

  // ONE competition-scoped lock, held SESSION-level on a connection outside the
  // pool for the WHOLE rewind below (`withSessionLocks`, lib/db.ts).
  //
  // What it is for, in order of how often it happens: the SAME organiser
  // submitting twice. A double-clicked Undo, a second browser tab, or a retry
  // after a slow response all produce a second joint write over the same
  // divisions while the first is still rewinding — and this product's normal
  // shape is one owner running scheduling, so that is the realistic race, not
  // two admins working at once. Two admins are the same race with a rarer
  // cause. Without the lock the second submission interleaves with the first's
  // rewind steps and the board ends up in a state neither one asked for.
  //
  // It cannot be the `division:` key. Session and transaction advisory locks
  // share one lock space, and every rewind step below takes
  // `pg_advisory_xact_lock(hashtext('division:' + id))` of its own (`step()` in
  // history.ts) on a POOL connection. Holding `division:` here would block those
  // steps forever — nothing sets a lock_timeout — so the restore would hang
  // itself. Verified against Postgres: with a lock_timeout the waiter dies
  // 55P03. Hence a second namespace that `applyCompetitionSchedule` also takes.
  //
  // THE LIMIT, stated plainly because the comment this replaced claimed a
  // guarantee the code did not have: this excludes a concurrent JOINT apply and
  // nothing else. A single-division apply or edit takes only `division:` locks,
  // so it still interleaves between rewind steps exactly as it does today.
  //
  // The WAIT is bounded, for the same reason the apply's is: a second undo of
  // the same competition is nearly always the SAME organiser submitting twice —
  // a double-clicked Undo, a second tab, a retry after a slow response — and
  // parking it on the lock pins a second out-of-pool connection for as long as
  // the first rewind runs, then does the undo again for no benefit. Five
  // seconds, matching the apply side, then the retryable 409 both paths use.
  try {
    return await withSessionLocks(
      [`joint:${competitionId}`],
      async () => {
        // Read UNDER the lock. Read before it, this validated against a world a
        // joint apply could already have replaced: the endpoint would approve a
        // division set that was superseded in the gap, and self-heal only by
        // accident, when the new apply happened to move the same divisions'
        // watermarks (restoreCheckpoint, history.ts). The lock exists to
        // exclude a concurrent apply, so the precondition it protects has to be
        // read inside it.
        const applied = await withTenant(auth.orgId, async (tx) => {
          const [row] = await tx<{ payload: { division_ids?: string[] } }[]>`
            select payload from competition_events
             where competition_id = ${competitionId} and org_id = ${auth.orgId}
               and type = ${JOINT_APPLY_EVENT}
             -- Ordered exactly as lastCompetitionAiApply orders the same rows
             -- (competition-schedule-ai.ts): competition_events has no seq
             -- column, so a created_at tie is broken by the id and by nothing
             -- else. The two readers must not drift - they answer the same
             -- question.
             order by created_at desc, id desc
             limit 1`;
          if (!row) throw new HttpError(404, "no joint apply to restore");
          return row.payload.division_ids ?? [];
        });

        const askedSorted = [...asked].sort();
        const appliedSorted = [...applied].sort();
        const same =
          askedSorted.length === appliedSorted.length &&
          askedSorted.every((id, i) => id === appliedSorted[i]);
        if (!same) {
          throw new HttpError(
            422,
            "a joint restore must name exactly the divisions the apply wrote",
          );
        }

        const restored: CompetitionRestoreOut["restored"] = [];
        const failed: CompetitionRestoreOut["failed"] = [];
        for (const c of [...input.checkpoints].sort((a, b) =>
          a.division_id.localeCompare(b.division_id),
        )) {
          try {
            const out = await restoreCheckpoint(auth, c.division_id, c.checkpoint_id, true);
            restored.push({
              division_id: c.division_id,
              watermark: out.watermark,
              steps: out.steps,
            });
          } catch (err) {
            // Kept going on purpose: stopping at the first refusal would leave
            // MORE divisions carrying the AI board than carrying on does, and
            // the caller needs to know WHICH divisions still do.
            failed.push({
              division_id: c.division_id,
              reason: err instanceof Error ? err.message : "restore failed",
            });
          }
        }
        return { restored, failed, ok: failed.length === 0 };
      },
      { lockTimeoutMs: RESTORE_LOCK_TIMEOUT_MS },
    );
  } catch (err) {
    // Only the ACQUISITION throws this — the body above turns every rewind
    // failure into a `failed` entry — so it cannot swallow a real error.
    if (err instanceof SessionLockTimeoutError) {
      throw new HttpError(
        409,
        "a restore is already in progress for this competition — try again in a moment",
        "SCHEDULE_APPLY_RESTORE_IN_PROGRESS",
      );
    }
    throw err;
  }
}

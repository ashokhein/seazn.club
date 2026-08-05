import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { JOINT_APPLY_EVENT } from "./competition-schedule-ai";
import { restoreCheckpoint } from "./history";

/** Reported for every division the rewind did NOT attempt because a NEWER joint
 *  apply landed on the competition part-way through (the anchor check below).
 *  Phrased as what the organiser needs to know: nothing changed here, and the
 *  anchors they are holding no longer describe the board. */
const SUPERSEDED_REASON =
  "a newer joint apply landed on this competition while the undo was running — " +
  "nothing was changed here, and this undo's save points no longer match the board";

export interface CompetitionRestoreOut {
  restored: { division_id: string; watermark: number; steps: number }[];
  failed: { division_id: string; reason: string }[];
  ok: boolean;
}

interface JointApply {
  /** The `competition_events` row id — the ANCHOR the rewind loop rechecks. */
  id: string;
  divisionIds: string[];
}

/**
 * The newest `schedule.applied_multi` row of one competition, or undefined if
 * the competition has never had a joint apply.
 *
 * ONE reader for both jobs below — the initial read and the per-division
 * recheck — so the two cannot drift into answering different questions about
 * the same rows. The ordering matches `lastCompetitionAiApply`
 * (competition-schedule-ai.ts) for the same reason: competition_events has no
 * seq column, so a created_at tie is broken by the id and by nothing else, and
 * two readers that break it differently would disagree about which apply is the
 * restorable one.
 */
async function latestJointApply(
  auth: AuthCtx,
  competitionId: string,
): Promise<JointApply | undefined> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; payload: { division_ids?: string[] } }[]>`
      select id, payload from competition_events
       where competition_id = ${competitionId} and org_id = ${auth.orgId}
         and type = ${JOINT_APPLY_EVENT}
       -- Ordered exactly as lastCompetitionAiApply orders the same rows
       -- (competition-schedule-ai.ts): competition_events has no seq
       -- column, so a created_at tie is broken by the id and by nothing
       -- else. The two readers must not drift - they answer the same
       -- question.
       order by created_at desc, id desc
       limit 1`;
    return row ? { id: row.id, divisionIds: row.payload.division_ids ?? [] } : undefined;
  });
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
 * What this endpoint adds instead: the loop runs on the server so it cannot be
 * abandoned mid-way by a client, a failure is REPORTED per division rather than
 * left for the caller to discover, and the division set is validated against
 * the apply event rather than trusted — the caller supplies the checkpoint
 * anchors (only the client holds them; the event carries `division_ids` and
 * nothing else), and the set must match the event's list exactly. A subset is a
 * 422, not a partial restore.
 *
 * ── THE ANCHOR, AND WHY IT IS NOT A LOCK ─────────────────────────────────────
 *
 * The concurrent write worth detecting is a JOINT APPLY landing on the same
 * competition while this rewind is running: after it, the anchors in this
 * request describe a board the organiser has already replaced, and rewinding to
 * them would undo the NEW schedule rather than the old one.
 *
 * So the newest joint-apply event is read ONCE, its row id kept as the anchor,
 * and re-read before each division. A different id means a new apply committed
 * in the gap: the loop STOPS, every division it has not reached is reported in
 * `failed` with the reason above, and `ok` is false. Divisions already rewound
 * keep their real `steps` and `watermark` in `restored` — that partial report is
 * the contract. Throwing would discard a truthful record of writes that really
 * happened and leave the organiser guessing which divisions still carry the AI
 * board.
 *
 * DETECTION, NOT EXCLUSION, and the difference matters less than it reads.
 * This endpoint used to hold a competition-scoped session advisory lock across
 * the whole rewind, which the apply also took. It was wrong in four of six
 * review rounds, each time FAIL-OPEN — it claimed exclusion while providing
 * none: taken inside a transaction that committed immediately (a barrier, not a
 * lock); then self-deadlocking against the rewind's own `division:` locks;
 * then silently handed back when postgres.js closed the idle lock connection at
 * `idle_timeout`; then "proved" by a keepalive that showed the CONNECTION was
 * alive rather than that the same backend still held the key, because
 * postgres.js reconnects transparently. A guard whose failure mode is invisible
 * is worse than no guard, because the code above it is written as though it
 * cannot happen.
 *
 * And the protection it really delivered was already per-division: a lock lost
 * inside one `restoreCheckpoint` — up to 500 appends — was not noticed until
 * the next iteration of this loop. The anchor recheck is read at exactly that
 * same granularity, so this is the same protection with none of the liveness
 * assumptions that failed four times.
 *
 * DOUBLE-SUBMIT is handled where it happens, in the client: the console's undo
 * holds an in-flight ref and disables the button for the duration
 * (`ai-competition-console.tsx`). A second browser tab or a reload-retry is real
 * but rare, and it is benign here — a second undo of the same apply rewinds to
 * the same anchors, which is idempotent (`restoreCheckpoint` reports 0 steps
 * when the division is already there).
 */
export async function restoreCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: { checkpoints: { division_id: string; checkpoint_id: string }[]; confirm: true },
): Promise<CompetitionRestoreOut> {
  // Body checks first: rejecting a malformed request needs no database at all.
  //
  // The PRECEDENCE is deliberate, not incidental. A body naming a division
  // TWICE against a competition with NO joint apply answers 422, not 404. The
  // body is wrong whatever the database holds, so the status must not depend on
  // a read the request never earned — and a caller told "no joint apply to
  // restore" would go hunting for a missing event instead of looking at the
  // duplicate it sent. Moving either check below the event read flips this, so
  // it is pinned by a test.
  if (!input.confirm) throw new HttpError(422, "restore requires confirm: true");
  const asked = input.checkpoints.map((c) => c.division_id);
  if (new Set(asked).size !== asked.length) throw new HttpError(422, "a division was named twice");

  const anchor = await latestJointApply(auth, competitionId);
  if (!anchor) throw new HttpError(404, "no joint apply to restore");

  const askedSorted = [...asked].sort();
  const appliedSorted = [...anchor.divisionIds].sort();
  const same =
    askedSorted.length === appliedSorted.length &&
    askedSorted.every((id, i) => id === appliedSorted[i]);
  if (!same) {
    throw new HttpError(422, "a joint restore must name exactly the divisions the apply wrote");
  }

  const restored: CompetitionRestoreOut["restored"] = [];
  const failed: CompetitionRestoreOut["failed"] = [];
  let superseded = false;
  for (const c of [...input.checkpoints].sort((a, b) =>
    a.division_id.localeCompare(b.division_id),
  )) {
    // Re-read per division, not once: a joint apply can commit at any point in
    // this loop, and every division after it would otherwise rewind against
    // anchors that no longer describe the board. A cheap indexed read of one
    // row, against a rewind of up to 500 appends.
    if (!superseded) {
      const current = await latestJointApply(auth, competitionId);
      // `current` can also be undefined — the event deleted underneath us — and
      // that is a change too: this undo can no longer prove what it is undoing.
      if (current?.id !== anchor.id) superseded = true;
    }
    if (superseded) {
      failed.push({ division_id: c.division_id, reason: SUPERSEDED_REASON });
      continue;
    }
    try {
      const out = await restoreCheckpoint(auth, c.division_id, c.checkpoint_id, true);
      restored.push({
        division_id: c.division_id,
        watermark: out.watermark,
        steps: out.steps,
      });
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

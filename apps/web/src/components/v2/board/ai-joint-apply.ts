// The JOINT accept (#350 Task 8) — the multi-division twin of `applyAiPlans`.
//
// It exists for one reason the per-stage chain cannot serve: the joint plan is
// written by ONE endpoint (`POST /competitions/{id}/schedule/apply`, atomic
// across divisions), so the board never runs `ai-apply.ts`, and the undo anchor
// that chain creates before it writes never gets created either. A joint apply
// therefore overwrote several divisions' boards with no restore point at all.
//
// There is no competition-scoped checkpoint or restore endpoint, so the anchor
// is per division: one `kind: "ai"` checkpoint for every division the apply will
// touch, taken BEFORE the write, and Undo restores each of them. `kind: "ai"`
// anchors are exempt from the save-point quota (V303), so this costs a Community
// org nothing.
//
// Pure and React-free with an injected api seam, exactly as ai-apply.ts is, so
// the call order and the payloads are assertable without a server.
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import type { AiApplyMeta } from "@/server/api-v1/schemas";
import { aiCheckpointLabel } from "./ai-apply";

/** One division's slice of the joint write. `expectedSeq` is REQUIRED by the
 *  endpoint — a joint write that skipped the check on one division would let a
 *  stale board silently overwrite a concurrent edit there. */
export interface JointApplyDivision {
  divisionId: string;
  expectedSeq: number;
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
}

export interface JointApplyInput {
  competitionId: string;
  divisions: JointApplyDivision[];
  audit: AiApplyMeta;
  /** Fixtures the organiser set aside. They stay at their CURRENT slot, where
   *  they remain court obstacles — which is why a partial apply can be refused
   *  for a clash that did not exist at plan time. Filtered here, not by the
   *  caller, so the rule lives in one place. */
  excludedFixtureIds: string[];
  checkpointLabel?: string;
}

export interface JointCheckpoint {
  divisionId: string;
  checkpointId: string;
}

/** The ENGINE verifier's camelCase conflict, as the 409 envelope carries it. */
export interface JointConflict {
  fixtureId: string;
  reason: string;
  detail?: string;
}

export interface JointApplyOutcome {
  /** `seq_conflict` is the only recoverable refusal (re-run as a refine over the
   *  fresh board); `conflict` is a real double-booking and carries the list. */
  status: "applied" | "seq_conflict" | "conflict" | "error";
  /** The undo anchors, in creation order. Present even on a refusal — they were
   *  taken before the write, so they are still valid restore targets. */
  checkpoints: JointCheckpoint[];
  applied: number;
  conflicts: JointConflict[];
  errorCode?: string;
  errorStatus?: number;
}

/** The injected fetch seam — apiV1's shape (envelope already unwrapped). */
export type JointApplyApi = <T>(
  url: string,
  options?: { method?: string; json?: unknown },
) => Promise<T>;

const codeOf = (err: unknown): string => (err instanceof ApiV1Error ? err.code : "UNKNOWN");
const statusOf = (err: unknown): number => (err instanceof ApiV1Error ? err.status : 0);
/** A checkpoint POST that trips the save-point quota answers PAYMENT_REQUIRED
 *  with `feature_key = "schedule.checkpoints.max"`; surface that so the console
 *  shows the save-point line rather than "upgrade to use AI". */
const featureKeyOf = (err: unknown): string | undefined =>
  err instanceof ApiV1Error && typeof err.extra.feature_key === "string"
    ? err.extra.feature_key
    : undefined;

function conflictsOf(err: unknown): JointConflict[] {
  if (!(err instanceof ApiV1Error)) return [];
  const raw = err.extra.conflicts;
  return Array.isArray(raw) ? (raw as JointConflict[]) : [];
}

/**
 * Anchor every division, then write them all in one transaction.
 *
 * The order is the contract: anchors first, so a refusal (or a regretted apply)
 * always has somewhere to go back to. If an anchor fails, nothing has been
 * written yet — surface it and stop rather than writing an unrecoverable board.
 */
export async function applyJointPlan(
  input: JointApplyInput,
  api: JointApplyApi = apiV1,
): Promise<JointApplyOutcome> {
  const excluded = new Set(input.excludedFixtureIds);
  // Divisions with nothing left after the set-aside filter drop out entirely:
  // `assignments` is `.min(1)` per division on the wire, and a division nothing
  // is written to needs no anchor either.
  const wanted = input.divisions
    .map((d) => ({ ...d, assignments: d.assignments.filter((a) => !excluded.has(a.fixture_id)) }))
    .filter((d) => d.assignments.length > 0);

  const empty: JointApplyOutcome = { status: "error", checkpoints: [], applied: 0, conflicts: [] };
  if (wanted.length === 0) return { ...empty, errorCode: "NO_ASSIGNMENTS" };

  const label = input.checkpointLabel ?? aiCheckpointLabel();
  const checkpoints: JointCheckpoint[] = [];
  for (const d of wanted) {
    try {
      const cp = await api<{ id: string }>(`/api/v1/divisions/${d.divisionId}/checkpoints`, {
        method: "POST",
        json: { label, kind: "ai" },
      });
      checkpoints.push({ divisionId: d.divisionId, checkpointId: cp.id });
    } catch (err) {
      return {
        status: "error",
        checkpoints,
        applied: 0,
        conflicts: [],
        errorCode: featureKeyOf(err) ?? codeOf(err),
        errorStatus: statusOf(err),
      };
    }
  }

  try {
    const res = await api<{ applied: number; conflicts: JointConflict[] }>(
      `/api/v1/competitions/${input.competitionId}/schedule/apply`,
      {
        method: "POST",
        json: {
          divisions: wanted.map((d) => ({
            division_id: d.divisionId,
            expected_seq: d.expectedSeq,
            assignments: d.assignments,
          })),
          source: "ai",
          ai: input.audit,
        },
      },
    );
    return {
      status: "applied",
      checkpoints,
      applied: res.applied,
      conflicts: res.conflicts ?? [],
    };
  } catch (err) {
    const code = codeOf(err);
    return {
      status:
        code === "SEQ_CONFLICT"
          ? "seq_conflict"
          : code === "SCHEDULE_CONFLICT"
            ? "conflict"
            : "error",
      checkpoints,
      applied: 0,
      conflicts: conflictsOf(err),
      errorCode: code,
      errorStatus: statusOf(err),
    };
  }
}

/**
 * Restore every anchor the apply created. Returns false if any division refused.
 *
 * It keeps going after a failure on purpose: restore is per division and there
 * is no competition-scoped one, so stopping at the first refusal would leave
 * MORE divisions holding the AI board than carrying on does.
 */
export async function undoJointApply(
  checkpoints: JointCheckpoint[],
  api: JointApplyApi = apiV1,
): Promise<boolean> {
  let ok = true;
  for (const cp of checkpoints) {
    try {
      await api(`/api/v1/divisions/${cp.divisionId}/restore`, {
        method: "POST",
        json: { checkpoint_id: cp.checkpointId, confirm: true },
      });
    } catch {
      ok = false;
    }
  }
  return ok;
}

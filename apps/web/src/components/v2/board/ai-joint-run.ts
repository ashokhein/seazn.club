// The JOINT run — the request that SPENDS, and the guard that stops one intent
// spending twice.
//
// Split out of the console for two reasons, both of which cost money:
//
//   * `POST /schedule/ai-plan` calls `spendCredit(walletId, orgId, quote.credits)`
//     with NO idempotency key, a joint plan takes tens of seconds, and the
//     review step's re-run button had no in-flight state at all. A second click
//     was the expected user behaviour and it charged twice. A `disabled`
//     attribute is the affordance; `ctl.inFlight` is the protection, because it
//     is set synchronously and so also covers the click that beats the
//     re-render.
//   * The body was an inline expression inside a component, i.e. outside every
//     test boundary. Three mutations of it survived a fully green suite — the
//     worst dropping the organiser's rung picks, so the card showed a
//     down-picked price and the server sized (and charged) from its own higher
//     prediction. What is DISPLAYED was pinned; what is SENT was not.
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { isRung, type Rung } from "@/lib/ai-rung";
import type {
  AiCompetitionPlanRequest,
  AiCompetitionPlanResponse,
  AiParsePreviewRequest,
  AiParsePreviewResponse,
} from "@/server/api-v1/schemas";

export type JointApi = <T>(
  url: string,
  options?: { method?: string; json?: unknown },
) => Promise<T>;

export interface JointRunInput {
  competitionId: string;
  selected: string[];
  instruction: string;
  rungs: Record<string, number | null>;
  prior?: AiCompetitionPlanResponse | null;
  /** W5 (#400): the compile the organiser confirmed. Sending it is what makes
   *  the rules they were shown the rules that run — and what stops the server
   *  paying for a second parse round. Absent when they took the preference
   *  fallback after a failed compile, which is the one path where nothing was
   *  confirmed and the server compiles inline exactly as it did before. */
  previewId?: string | null;
}

/** What a joint compile is asked about. Deliberately the run's own inputs minus
 *  the ones that only a run has: stage 1 costs nothing and calls no architect. */
export type JointPreviewInput = Pick<
  JointRunInput,
  "competitionId" | "selected" | "instruction" | "rungs"
>;

export type JointPreviewResult =
  | { status: "refused" }
  | { status: "compiled"; preview: AiParsePreviewResponse }
  | { status: "failed"; httpStatus: number; code?: string };

export type JointRunResult =
  | { status: "refused" }
  | { status: "planned"; plan: AiCompetitionPlanResponse }
  | { status: "failed"; httpStatus: number; code?: string };

export function rungOverrides(
  rungs: Record<string, number | null>,
  selected: string[],
): { rung_overrides?: Record<string, Rung> } {
  const out: Record<string, Rung> = {};
  for (const id of selected) {
    const r = rungs[id];
    if (r !== null && r !== undefined && isRung(r)) out[id] = r;
  }
  return Object.keys(out).length > 0 ? { rung_overrides: out } : {};
}

/**
 * The COMPILE request — stage 1 only, and the joint route's own shape.
 *
 * `division_ids` is the load-bearing field and the reason this is not the
 * single-division body with a different URL: the resolver reads the window from
 * the divisions in scope, so a compile taken over two divisions describes a
 * different run from one taken over three. The server agrees — a `preview_id`
 * minted for another set is refused 409 PREVIEW_STALE — so a compile posted
 * without them is a receipt for a run nobody asked for.
 *
 * The rungs ride along for the same reason they ride on the run: the
 * affordability refusal must price the run that is actually on offer.
 */
export function jointPreviewBody(input: JointPreviewInput): AiParsePreviewRequest {
  return {
    instruction: input.instruction.trim(),
    division_ids: input.selected,
    ...rungOverrides(input.rungs, input.selected),
  };
}

export function jointRunBody(input: JointRunInput): AiCompetitionPlanRequest {
  const text = input.instruction.trim();
  return {
    division_ids: input.selected,
    instruction: text,
    mode: input.prior ? "refine" : "generate",
    ...rungOverrides(input.rungs, input.selected),
    ...(input.previewId ? { preview_id: input.previewId } : {}),
    ...(input.prior
      ? {
          prior: {
            instruction: text,
            assignments: input.prior.proposal.map((p) => ({
              fixture_id: p.fixture_id,
              scheduled_at: p.scheduled_at,
              court_label: p.court_label,
              division_id: p.division_id,
            })),
          },
        }
      : {}),
  };
}

/**
 * Compile the instruction, at most once at a time.
 *
 * Spends nothing: no credit moves and no architect is called, which is what
 * makes declining the result free. It still takes the SAME in-flight box as the
 * run, because the two are alternatives — a compile and a chargeable run must
 * never be in the air together for one intent, and the guard that stops the
 * second click of a run is the guard that stops the second click of a compile.
 */
export async function runJointPreview(
  input: JointPreviewInput,
  ctl: { inFlight: { current: boolean }; onStart?: () => void },
  api: JointApi = apiV1,
): Promise<JointPreviewResult> {
  if (ctl.inFlight.current) return { status: "refused" };
  ctl.inFlight.current = true;
  try {
    ctl.onStart?.();
    const preview = await api<AiParsePreviewResponse>(
      `/api/v1/competitions/${input.competitionId}/schedule/ai-preview`,
      { method: "POST", json: jointPreviewBody(input) },
    );
    return { status: "compiled", preview };
  } catch (err) {
    if (!(err instanceof ApiV1Error)) return { status: "failed", httpStatus: 0 };
    const code = typeof err.extra.feature_key === "string" ? err.extra.feature_key : err.code;
    return { status: "failed", httpStatus: err.status, code };
  } finally {
    ctl.inFlight.current = false;
  }
}

/**
 * Run the joint plan, at most once at a time.
 *
 * `ctl.inFlight` is a plain mutable box (a React ref at the call site) rather
 * than component state on purpose: state is read through a closure that a
 * second click can beat, and this guard has to hold for exactly that click.
 * `onStart` fires only after the guard passes, so a refused call cannot start a
 * spinner or clear the error belonging to the run that is still going.
 *
 * The guard is released in `finally` — including on failure, or a 402 would
 * lock the organiser out of retrying after topping up, and including when
 * `onStart` itself throws, which is why that call sits inside the `try`.
 */
export async function runJointPlan(
  input: JointRunInput,
  ctl: { inFlight: { current: boolean }; onStart?: () => void },
  api: JointApi = apiV1,
): Promise<JointRunResult> {
  if (ctl.inFlight.current) return { status: "refused" };
  ctl.inFlight.current = true;
  try {
    // Inside the try, not before it: this was the only statement between
    // setting the guard and the `finally` that releases it, so a throw here was
    // the one path that could latch the guard and lock the organiser out for
    // the life of the mount. Still AFTER the guard, so a refused second click
    // cannot start a spinner or clear the error of the run still going.
    ctl.onStart?.();
    const plan = await api<AiCompetitionPlanResponse>(
      `/api/v1/competitions/${input.competitionId}/schedule/ai-plan`,
      { method: "POST", json: jointRunBody(input) },
    );
    return { status: "planned", plan };
  } catch (err) {
    if (!(err instanceof ApiV1Error)) return { status: "failed", httpStatus: 0 };
    const code = typeof err.extra.feature_key === "string" ? err.extra.feature_key : err.code;
    return { status: "failed", httpStatus: err.status, code };
  } finally {
    ctl.inFlight.current = false;
  }
}

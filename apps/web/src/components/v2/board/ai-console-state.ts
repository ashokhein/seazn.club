// AI schedule console — pure state machine (v4 Task 11, design/v4/00-03).
//
// The console is a four-step wizard over the two-phase AI architect: write a
// brief, review the engine-verified schedule proposal, optionally assign
// officials, then apply. This module is deliberately React-free so the gating
// (you can't reach officials without a schedule plan; apply is reachable
// straight from schedule; an error never discards the proposal you're looking
// at) is unit-testable in isolation. Tasks 12–16 consume these types verbatim.
import type {
  AiPlanResponse,
  AiOfficialsPlanResponse,
  AiParsePreviewResponse,
} from "@/server/api-v1/schemas";
import type { ApplyOutcome } from "./ai-apply";

export type AiStep = "brief" | "schedule" | "officials" | "apply";
export type AiRunState =
  | "idle"
  | "running"
  | "flagged"
  | "proposal"
  | "applied"
  | "seq_conflict"
  | "error";
export type AiMode = "generate" | "refine" | "repair";

/**
 * Optional narrowing for a run — a repair window and/or a court subset.
 *
 * `pool_ids` WAS DECLARED HERE and forwarded to the server, but nothing on the
 * board could emit it: the sole scope producer (use-disruption-signals) returns
 * `{courts?, from?}`. It is deliberately removed rather than left as a spare
 * option, because the confirm card now mirrors the server's `inScope` to price a
 * scoped repair and `MovableFixture` carries no `pool_id` — a pool scope would
 * have narrowed the CHARGE while the card went on quoting the whole division.
 * Re-adding it means adding `pool_id` to `MovableFixture` and the third
 * predicate to `movableForRun` in the same change.
 */
export interface AiScope {
  from?: string;
  courts?: string[];
}

export interface AiConsoleState {
  step: AiStep;
  run: AiRunState;
  mode: AiMode;
  /** Phase A (schedule) brief. */
  instruction: string;
  /** Phase B (officials) brief — kept separate so switching steps never
   *  clobbers the other phase's text. */
  officialsInstruction: string;
  scope?: AiScope;
  /** Credit rung the organiser picked on the confirm card (#348). `null` — the
   *  initial state — means "follow the server's prediction", which is NOT the
   *  same as picking 1: the request then omits `rung` entirely and the server
   *  sizes the run itself. Only 1|2|3 are ever sent; the field is a plain
   *  `number` so the reducer stays free of the Rung import and any junk value
   *  is filtered at the request boundary rather than trusted here. */
  rung: number | null;
  /** Phase B's own rung. Separate from `rung` on purpose: officials packs are
   *  priced with different weights (`officialsRungWeights`) over a different
   *  pack, so the two phases predict independently and one phase's choice must
   *  never be read as the other's. */
  officialsRung: number | null;
  /**
   * The Phase B brief that produced the officials proposal currently on screen.
   *
   * Reducer state rather than a ref, because it is a PRICE input and not
   * bookkeeping: the per-cell adopt re-runs on this string rather than on the
   * textarea, so an empty textarea with a non-empty value here still means a
   * chargeable run is one click away. Living in the reducer means "what did the
   * last run ask for" is written in exactly one place and can be asserted
   * directly — a ref assigned inside an async callback cannot be, which is how
   * the under-quote guard came to be untested.
   *
   * THIS VALUE TOUCHES MONEY. It has three consumers, and the first of them is
   * a charge, not a record:
   *   1. `ai-console.tsx` `onAdopt` sends it as the run's own `instruction` —
   *      and `input.instruction.trim() === ""` is the single thing that picks
   *      `freeDraftQuote` over `quoteRun` server-side (`officials-ai.ts:1104`,
   *      spent at `:1130`). Empty here = charged 1; non-empty = charged 1/2/3.
   *   2. `officialsPlanBody` puts it on the wire as `prior.instruction`.
   *   3. the apply audit line.
   * Because (1) both sets the price and is what the confirm card reads
   * (`adoptInstruction`), the two cannot drift: a wrong value here changes the
   * quote and the charge together. Anything that makes the card read a
   * DIFFERENT string than `onAdopt` sends reopens the under-quote.
   */
  officialsPriorInstruction: string;
  schedulePlan: AiPlanResponse | null; // Phase A result
  officialsPlan: AiOfficialsPlanResponse | null; // Phase B result
  /** Blocking fixtures the organiser unticked in the diff panel — they drop to
   *  the tray (unscheduled) in the accept payload rather than block the whole
   *  apply (02 §6). Task 15's accept reads this; Task 13 only wires it. Cleared
   *  whenever a fresh proposal lands. */
  excludedFixtures: string[];
  /**
   * W5 (#400) — the compiled-instruction preview, and the gate that makes
   * "declining spends no credit" a fact rather than a claim.
   *
   * The organiser's first click compiles their sentence (stage 1 only, no
   * credit, no architect call) and lands the result here. Only then does
   * {@link canRun} return true. The gate lives in this reducer, NOT in the
   * button's `disabled` attribute: a JSX-only gate is one refactor away from
   * vanishing with nothing red to show for it, and what it guards is money.
   */
  preview: {
    status: "idle" | "loading" | "ready" | "error";
    /** What the compiler produced, as the card renders it. */
    data: AiParsePreviewResponse | null;
    /** Reuse token for the run. Null on a failed compile — there is nothing to
     *  confirm then, only a fallback to choose. */
    id: string | null;
    /** Set ONLY by an explicit organiser choice after a failed compile
     *  (`PREVIEW_AS_PREFERENCE`). The run then posts without a `preview_id`, so
     *  the server compiles inline exactly as it did before this wave and
     *  nothing pretends the sentence is enforced. Never set by the reducer on
     *  its own — a silent fallback is the failure this wave exists to close. */
    asPreference: boolean;
    /** The TRIMMED instruction this preview was taken for. `canRun` compares it
     *  with the current one, so rules confirmed for one sentence can never run
     *  another even if some future action forgets to clear the slice. */
    instruction: string | null;
  };
  /** The last failed run/apply. `key` is the copy key aiErrorKey/applyErrorKey
   *  resolved to (the render reads it to enrich the `ai.credits` out-of-credits
   *  state into an action block); it's optional so the reducer's callers can omit
   *  it and the pure reducer tests stay shape-agnostic. */
  error: { status: number; message: string; key?: string } | null;
}

export type AiConsoleAction =
  | { type: "SET_INSTRUCTION"; value: string; officials?: boolean }
  | { type: "SET_MODE"; mode: AiMode }
  | { type: "SET_SCOPE"; scope: AiScope | undefined }
  // Two actions rather than one with an `officials?` flag: a dropped flag is a
  // silent mis-wire (Phase B's card writes Phase A's rung, and the price the
  // organiser confirmed is not the price sent), and no static-markup test can
  // catch a missing property on a dispatch. Separate types make it a compile
  // error instead of a test we do not have.
  | { type: "SET_RUNG"; rung: number | null }
  | { type: "SET_OFFICIALS_RUNG"; rung: number | null }
  // W5 (#400) — the two-stage gate. PREVIEW_AS_PREFERENCE is deliberately its
  // own action rather than a flag on PREVIEW_READY: it is the organiser saying
  // "send it unenforced anyway", and it must be impossible to reach by any path
  // other than their own click on the failed card.
  | { type: "PREVIEW_START" }
  | { type: "PREVIEW_READY"; preview: AiParsePreviewResponse }
  | { type: "PREVIEW_ERROR"; error: { status: number; message: string; key?: string } }
  | { type: "PREVIEW_DISMISS" }
  | { type: "PREVIEW_AS_PREFERENCE" }
  | { type: "RUN_START" }
  | { type: "RUN_FLAGGED" }
  | { type: "RUN_DONE"; plan: AiPlanResponse }
  | { type: "RUN_ERROR"; error: { status: number; message: string; key?: string } }
  | { type: "GOTO_STEP"; step: AiStep }
  // Carries the instruction that produced `plan` — the officials confirm card
  // prices the adopt path off it, so it must be recorded by the same action
  // that records the plan rather than by a side-write nobody can observe.
  | { type: "OFFICIALS_DONE"; plan: AiOfficialsPlanResponse; instruction: string }
  | { type: "TOGGLE_EXCLUDE"; fixtureId: string }
  | { type: "APPLY_START" }
  | { type: "APPLY_SEQ_CONFLICT" }
  | { type: "APPLY_ERROR"; error: { status: number; message: string; key?: string } }
  | { type: "APPLIED" }
  | { type: "RESET" }
  | { type: "PREFILL_REPAIR"; scope?: AiScope };

/** No compile in hand. Written in one place so every path that drops a
 *  preview — declining, editing, running, resetting — drops all of it, and a
 *  half-cleared slice cannot leave a stale id behind to be posted. */
const IDLE_PREVIEW: AiConsoleState["preview"] = {
  status: "idle",
  data: null,
  id: null,
  asPreference: false,
  instruction: null,
};

export const initialAiConsoleState: AiConsoleState = {
  step: "brief",
  run: "idle",
  mode: "generate",
  instruction: "",
  officialsInstruction: "",
  scope: undefined,
  rung: null,
  officialsRung: null,
  officialsPriorInstruction: "",
  schedulePlan: null,
  officialsPlan: null,
  excludedFixtures: [],
  preview: IDLE_PREVIEW,
  error: null,
};

export function aiConsoleReducer(s: AiConsoleState, a: AiConsoleAction): AiConsoleState {
  switch (a.type) {
    case "SET_INSTRUCTION":
      // Phase B's brief is a different sentence for a different run — it must
      // never invalidate (or validate) Phase A's compile.
      if (a.officials) return { ...s, officialsInstruction: a.value };
      // Editing the sentence drops the rules compiled from the old one.
      // Compared TRIMMED, so adding a trailing space does not send the
      // organiser back to re-check a preview that still describes their text.
      return {
        ...s,
        instruction: a.value,
        preview:
          s.preview.instruction !== null && s.preview.instruction !== a.value.trim()
            ? IDLE_PREVIEW
            : s.preview,
      };

    case "PREVIEW_START":
      // Records the sentence being compiled at the moment the request goes out,
      // so the response can only ever be attached to the text it was asked about.
      return {
        ...s,
        preview: { ...IDLE_PREVIEW, status: "loading", instruction: s.instruction.trim() },
        error: null,
      };

    case "PREVIEW_READY":
      // `id` comes off the response and nowhere else: a failed compile carries
      // no preview_id, which is exactly what keeps `canRun` false until the
      // organiser explicitly takes the preference fallback below.
      return {
        ...s,
        preview: {
          status: "ready",
          data: a.preview,
          id: a.preview.preview_id ?? null,
          asPreference: false,
          instruction: s.preview.instruction ?? s.instruction.trim(),
        },
      };

    case "PREVIEW_ERROR":
      // The compile round-trip failed (rate limit, no credit, offline). Keep the
      // brief; the console renders the same error block a failed run uses.
      return { ...s, preview: { ...IDLE_PREVIEW, status: "error" }, error: a.error };

    case "PREVIEW_DISMISS":
      // Declining. A pure client action: no request, nothing spent, and the
      // brief the organiser wrote is still on screen.
      return { ...s, preview: IDLE_PREVIEW };

    case "PREVIEW_AS_PREFERENCE":
      // The only writer of `asPreference`, reachable only from the failed card's
      // own button.
      return { ...s, preview: { ...s.preview, asPreference: true } };

    case "SET_MODE":
      return { ...s, mode: a.mode };

    case "SET_SCOPE":
      return { ...s, scope: a.scope };

    case "SET_RUNG":
      // Survives a run: the organiser's budget choice is about this division's
      // size, not about one attempt, so a refine after a generate keeps it.
      // RESET (closing the console) is what clears it back to the prediction.
      return { ...s, rung: a.rung };

    case "SET_OFFICIALS_RUNG":
      // Phase B keeps its own — same reasoning as `officialsInstruction`.
      return { ...s, officialsRung: a.rung };

    case "RUN_START":
      // A fresh run clears the last error but keeps the current proposal on
      // screen until the new one lands (refine/repair read as an in-place update).
      //
      // It also SPENDS the preview. The server marks the row consumed, so a
      // second POST carrying the same id is a 409 — holding the id here would
      // leave the console offering a token that can no longer be redeemed. The
      // run callback reads `state.preview.id` from its own closure before
      // dispatching this, so clearing it here cannot empty the request body.
      return { ...s, run: "running", preview: IDLE_PREVIEW, error: null };

    case "RUN_FLAGGED":
      // The engine flagged the model's draft and a repair round is underway.
      return { ...s, run: "flagged" };

    case "RUN_DONE":
      // Phase A landed: store it, show it, and move to the schedule step. A new
      // proposal has its own (possibly empty) set of blockers, so any prior
      // untick choices are dropped. It also invalidates the officials draft —
      // those assignments were assigned over the OLD times, so clear them; the
      // officials step re-runs its solver over the new schedule on next entry
      // (T14-reviewer staleness fix; the console resets officialsAutoStarted to
      // match). RESET stays the only action that clears schedulePlan.
      return {
        ...s,
        schedulePlan: a.plan,
        officialsPlan: null,
        run: "proposal",
        step: "schedule",
        excludedFixtures: [],
        error: null,
      };

    case "RUN_ERROR":
      // Keep whatever proposal the organiser was already looking at — an error
      // must never blank the board they were about to apply (brief §Step 1).
      return { ...s, run: "error", error: a.error };

    case "GOTO_STEP": {
      // Brief is always reachable (go back and re-brief). Every downstream step
      // needs a schedule plan to exist — including apply, which is reachable
      // from schedule with officials skipped.
      if (a.step === "brief") return { ...s, step: "brief" };
      if (!s.schedulePlan) return s; // gated no-op
      return { ...s, step: a.step };
    }

    case "OFFICIALS_DONE":
      // Recording the instruction alongside the plan is what makes the adopt
      // path priceable: adopt replays THIS brief, not the textarea, so the
      // confirm card reads it to decide whether a free draft is still on offer.
      return {
        ...s,
        officialsPlan: a.plan,
        officialsPriorInstruction: a.instruction,
        run: "proposal",
        step: "officials",
        error: null,
      };

    case "TOGGLE_EXCLUDE":
      // Per-row untick on a blocking fixture: toggle its membership in the
      // drop-to-tray set (02 §6). Accept (Task 15) enables once every blocker is
      // excluded.
      return s.excludedFixtures.includes(a.fixtureId)
        ? { ...s, excludedFixtures: s.excludedFixtures.filter((id) => id !== a.fixtureId) }
        : { ...s, excludedFixtures: [...s.excludedFixtures, a.fixtureId] };

    case "APPLY_START":
      // Clear any error from a prior apply attempt; the in-flight spinner is a
      // local console flag, so the run state is untouched until it resolves.
      return { ...s, error: null };

    case "APPLY_SEQ_CONFLICT":
      // The board moved under us (another organiser edited it). Keep the proposal
      // on screen; the apply step offers "re-run as refine" over the fresh board.
      return { ...s, run: "seq_conflict" };

    case "APPLY_ERROR":
      return { ...s, run: "error", error: a.error };

    case "APPLIED":
      return { ...s, run: "applied", step: "apply" };

    case "PREFILL_REPAIR":
      // Opened from a conflict/repair affordance: pre-arm repair mode + scope and
      // drop the organiser on the brief step to add a sentence. Plans are left
      // intact (RESET is the only action that clears them).
      return { ...s, mode: "repair", scope: a.scope, step: "brief", run: "idle", error: null };

    case "RESET":
      return initialAiConsoleState;

    default: {
      // Exhaustiveness guard — a new action must be handled above.
      const _never: never = a;
      return _never;
    }
  }
}

/**
 * W5 (#400) — may this state start a chargeable run?
 *
 * ONE definition, consumed by the single-division `BriefStep` and by the joint
 * console's brief alike, so the gate cannot hold on one surface and leak on the
 * other. Every clause below is a refusal that happens BEFORE any money moves:
 *
 *  - too short / busy / frozen — the pre-existing conditions, unchanged.
 *  - no ready preview — the organiser has not been shown what their sentence
 *    compiles to, so they cannot have agreed to it.
 *  - a preview for a DIFFERENT sentence — rules confirmed for one instruction
 *    must never execute another.
 *  - a failed compile with no explicit fallback — nothing to confirm, and
 *    falling back silently is the misreading this wave exists to stop.
 */
export function canRun(state: AiConsoleState, opts?: { scheduleFrozen?: boolean }): boolean {
  const instruction = state.instruction.trim();
  if (instruction.length < 3) return false;
  if (state.run === "running" || state.run === "flagged") return false;
  if (opts?.scheduleFrozen) return false;

  const p = state.preview;
  if (p.status !== "ready") return false;
  if (p.instruction !== instruction) return false;
  // A reusable compile, or an explicit "send it as a preference anyway".
  return p.id !== null || p.asPreference;
}

/** ui-catalog copy keys for a failed run. */
export type AiErrorKey =
  | "board.ai.error.upgrade"
  | "board.ai.error.outOfCredits"
  | "board.ai.error.unavailable"
  | "board.ai.error.rateLimited"
  | "board.ai.error.conflict"
  | "board.ai.error.tooLarge"
  | "board.ai.error.invalid"
  | "board.ai.errorGeneric";

/**
 * Map an HTTP status (+ the server error code where it sharpens the message) to
 * a localized copy key. Pure — unit-tested without React. The console resolves
 * the returned key through the ui catalog so a raw, untranslated server string
 * never reaches the UI. 422 splits on the code: AI_PLAN_TOO_LARGE asks the user
 * to narrow the scope; anything else is a plain "couldn't use that instruction".
 * 402 splits on the feature key: an empty AI credit wallet (feature_key
 * "ai.credits") asks the organiser to top up — AI is metered on every tier now,
 * so "upgrade to Pro" is only right for the plain (non-credit) paywall.
 */
export function aiErrorKey(status: number, code?: string): AiErrorKey {
  switch (status) {
    case 402:
      return code === "ai.credits" ? "board.ai.error.outOfCredits" : "board.ai.error.upgrade";
    case 503:
      // AI isn't configured on this server (no key / disabled) — a distinct line
      // from the run failures so the organiser isn't told to just try again.
      return "board.ai.error.unavailable";
    case 429:
      return "board.ai.error.rateLimited";
    case 409:
      return "board.ai.error.conflict";
    case 400:
      return "board.ai.error.invalid";
    case 422:
      return code === "AI_PLAN_TOO_LARGE" ? "board.ai.error.tooLarge" : "board.ai.error.invalid";
    default:
      return "board.ai.errorGeneric";
  }
}

/**
 * Map a failed apply outcome to a localized copy key. Reuses aiErrorKey over the
 * outcome's errorStatus/errorCode (a checkpoint 402 save-point cap, a schedule
 * 422 frozen/too-large, …) so an actionable server failure reaches the organiser
 * instead of the flat "couldn't apply, try again". When aiErrorKey can't sharpen
 * the status (its catch-all run-generic), fall back to the apply-specific generic
 * so the copy still reads as an apply failure. Pure — unit-tested without React.
 */
export function applyErrorKey(
  // The two fields it actually reads, so the JOINT apply's own outcome
  // (ai-joint-apply.ts) resolves its copy through this same mapping rather than
  // carrying a second, drifting copy of it.
  outcome: Pick<ApplyOutcome, "errorStatus" | "errorCode">,
): AiErrorKey | "board.ai.apply.error" | "board.ai.apply.checkpointQuota" {
  // A 402 at the checkpoint step is the save-point quota (schedule.checkpoints.max),
  // not the AI grade — AI is already granted on this tier, so route it to the
  // save-point line ("delete a save point or upgrade") instead of the generic
  // "upgrade to use AI" the plain 402 → error.upgrade mapping would give.
  if (outcome.errorStatus === 402 && outcome.errorCode === "schedule.checkpoints.max") {
    return "board.ai.apply.checkpointQuota";
  }
  const key = aiErrorKey(outcome.errorStatus ?? 0, outcome.errorCode);
  return key === "board.ai.errorGeneric" ? "board.ai.apply.error" : key;
}

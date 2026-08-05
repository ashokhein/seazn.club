"use client";

// AI schedule console (v4 Task 11): the docked four-step wizard over the two-
// phase AI architect. Chrome mirrors the unscheduled tray / conflicts panel —
// a right-docked panel on desktop, a bottom sheet on mobile — so it sits inside
// the board's existing vocabulary. The one flourish that marks this surface as
// "AI" is a restrained indigo→violet wash behind a sparkle; everything else is
// the board's slate/purple system. The reducer (ai-console-state) owns the
// state machine and gating; this component renders it and runs Phase A. Tasks
// 12–16 flesh out the schedule / officials / apply step bodies.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { track, EVENTS } from "@/lib/analytics";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { isRung, type Rung } from "@/lib/ai-rung";
import type { MessageKey } from "@/lib/messages";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import type { Currency } from "@/lib/currency";
import { AiOutOfCredits } from "./ai-out-of-credits";
import { RunElapsed } from "./run-elapsed";
import type {
  AiPlanRequest,
  AiPlanResponse,
  AiOfficialsPlanRequest,
  AiOfficialsPlanResponse,
  AiLastResult,
  AiParsePreviewResponse,
  ScheduleConfig,
} from "@/server/api-v1/schemas";
import {
  applyAiPlans,
  AI_APPLY_MODEL,
  mergeConstraintSuggestions,
  suggestionKeysOf,
  type ApplyOutcome,
  type SuggestionKey,
} from "./ai-apply";
import { AiWishChips } from "./ai-wish-chips";
import { AiPreflight, AiLastRun, type PreflightInput } from "./ai-preflight";
import { AiQuoteCard, quoteFor, type QuoteCardLine } from "./ai-quote-card";
import { useRungConfig } from "./rung-config-provider";
import { compileWishes, deriveFreeText, joinNonEmpty, type Wish } from "./wish-compile";
import { compileOfficialsWishes, type OfficialsWish } from "./officials-wish-compile";
import { AiTrace, type TraceEvent } from "./ai-trace";
import { AiDiffPanel } from "./ai-diff-panel";
import { AiReviewPanel } from "./ai-review-panel";
import { AiInstructionPreview } from "./ai-instruction-preview";
import { buildReviewRows } from "./ai-review";
import { AiOfficialsReview, type OfficialsRosterEntry } from "./ai-officials-review";
import type { AiConsoleFixture } from "./ai-diff";
import {
  aiConsoleReducer,
  aiErrorKey,
  applyErrorKey,
  canRun,
  initialAiConsoleState,
  type AiConsoleState,
  type AiMode,
  type AiScope,
  type AiStep,
} from "./ai-console-state";

/** The brief step's live inputs, derived by the board from data it already has
 *  (schedule config + fixtures + entrants). Officials come from a fetch-on-open
 *  in the console (kept out of the board's initial payload — gap 15); their
 *  blackout count is the one already-loaded page datum threaded here, since no
 *  client route exposes official availability. */
export interface AiBriefContext {
  /** Configured courts (settings.courts) — court picker + "courts set" row. */
  courts: string[];
  /** Session-window count. */
  windows: number;
  /** Blackout-period count. */
  blackouts: number;
  /** Any non-default constraint knobs set (rest / grouping / v2 constraints). */
  constraintsSet: boolean;
  /** Movable fixtures (status "scheduled") the AI would place — the fixtures
   *  themselves, not a count, because the confirm card has to narrow them by
   *  `scope` exactly as `buildSchedulePack` does, or a scoped repair quotes the
   *  whole division. `pool_id` is deliberately absent: the board's only scope
   *  producer (use-disruption-signals) emits `{courts?, from?}`, so these two
   *  fields are the complete mirror of the server's `inScope`. */
  movableFixtures: MovableFixture[];
  /** Pinned fixtures (schedule_locked) the AI must not move. */
  pinned: number;
  /** Entrants for the chip pickers, sorted by name. NOT a pricing input — this
   *  list is competition-wide and unfiltered (it is built from the board's
   *  `entrantNames` map), so pricing off it over-quotes a multi-division board
   *  several times over. Use `activeEntrants`. */
  entrants: { id: string; name: string }[];
  /** Entrants the SERVER prices on: this division's, `status not in
   *  ('withdrawn','disqualified')` (schedule-ai.ts:505). */
  activeEntrants: number;
  /** Officials with at least one blackout date (M in "N officials, M with …"). */
  officialsWithBlackout: number;
}

/** The fixture fields `inScope` reads — a structural subset of BoardFixture. */
export interface MovableFixture {
  id: string;
  /** ISO string, or null while the fixture sits in the tray. */
  scheduled_at: string | null;
  court_label: string | null;
}

/**
 * The client's mirror of `buildSchedulePack`'s movable-fixture selection
 * (schedule-ai.ts:319 + its `inScope` at :260).
 *
 * Scope only narrows a REPAIR round; generate and refine re-plan the whole set.
 * Getting this wrong is not cosmetic — a repair scoped to one court would
 * otherwise be quoted at the whole division's size, which is a rung-3 card
 * (3 credits) in front of a rung-1 charge.
 *
 * Pure and exported so the agreement with the server is testable without React.
 */
export function movableForRun(
  fixtures: MovableFixture[],
  mode: AiMode,
  scope: AiScope | undefined,
): MovableFixture[] {
  if (mode !== "repair" || !scope) return fixtures;
  return fixtures.filter((f) => {
    if (scope.courts && !(f.court_label === null || scope.courts.includes(f.court_label))) {
      return false;
    }
    if (scope.from) {
      const from = new Date(scope.from).getTime();
      if (!(f.scheduled_at === null || new Date(f.scheduled_at).getTime() >= from)) return false;
    }
    return true;
  });
}

/**
 * The rung a request may carry: 1|2|3, or ABSENT.
 *
 * `null` — the organiser left the control on the recommendation — must send no
 * `rung` at all, so the server sizes the run from its own prediction rather
 * than freezing a client-side estimate into the price. Anything that is not a
 * rung is dropped rather than trusted, because the reducer's field is a plain
 * `number`.
 *
 * Split out because it is the ONE line where a confirmed price becomes a sent
 * price, and the render tests cannot see a request body.
 */
export function rungField(rung: number | null): { rung?: Rung } {
  return rung !== null && isRung(rung) ? { rung } : {};
}

/**
 * The Phase A (schedule) request body. Pure, and exported, because everything
 * else about the confirm card is testable through the render and this is not:
 * a card can show the right number while the request carries a different one
 * (or none), and no static-markup assertion would notice.
 */
export function schedulePlanBody(
  state: Pick<AiConsoleState, "rung" | "scope" | "preview">,
  args: {
    instruction: string;
    mode: AiMode;
    officialsPolicy?: AiPlanRequest["officials_policy"] | null;
    prior?: AiPlanRequest["prior"] | null;
    /** #387: the credits the confirm card SHOWED. The server compares it to
     *  what it charges and records the divergence. Absent when no card was on
     *  screen (the seq-conflict re-run), because silence must never be read as
     *  "quoted zero". */
    quotedCredits?: number;
  },
): AiPlanRequest {
  return {
    instruction: args.instruction,
    mode: args.mode,
    ...(state.scope ? { scope: state.scope } : {}),
    // Reads `state.rung` ITSELF rather than accepting it as an argument. A
    // rung parameter leaves a call site that can quietly pass the OTHER
    // phase's field, and nothing short of driving a real request would catch
    // it — three mutations of exactly that shape survived a full green suite.
    ...rungField(state.rung),
    // W5 (#400): the compile the organiser confirmed. Read off `state.preview`
    // itself for exactly the reason `rung` is — a call site handed the id as an
    // argument is a call site that can pass the wrong one, and this one decides
    // whether the run executes under the rules that were shown or under a
    // second, unseen compile.
    //
    // Absent on the preference fallback, and that is the honest wire shape:
    // there is no stored parse to reuse, so the server compiles inline exactly
    // as it did before this wave and nothing claims the sentence is enforced.
    ...(state.preview.id ? { preview_id: state.preview.id } : {}),
    ...(args.officialsPolicy ? { officials_policy: args.officialsPolicy } : {}),
    ...(args.prior ? { prior: args.prior } : {}),
    ...(args.quotedCredits !== undefined ? { quoted_credits: args.quotedCredits } : {}),
  };
}

/** The Phase B (officials) request body — same reasoning, reading the
 *  `officialsRung` field Phase B's own card writes. */
export function officialsPlanBody(
  state: Pick<AiConsoleState, "officialsRung" | "officialsPriorInstruction">,
  args: {
    instruction: string;
    schedule: NonNullable<AiOfficialsPlanRequest["schedule"]>;
    policy: AiOfficialsPlanRequest["policy"];
    /** Round-tripped assignments; the brief they were produced under comes from
     *  state, so the two halves of `prior` cannot describe different runs. */
    priorAssignments?: AiOfficialsPlanResponse["assignments"] | null;
    /** #387 — see `schedulePlanBody`. */
    quotedCredits?: number;
  },
): AiOfficialsPlanRequest {
  return {
    instruction: args.instruction,
    ...rungField(state.officialsRung),
    ...(args.schedule.length > 0 ? { schedule: args.schedule } : {}),
    policy: args.policy,
    ...(args.priorAssignments
      ? {
          prior: {
            instruction: state.officialsPriorInstruction,
            assignments: args.priorAssignments,
          },
        }
      : {}),
    ...(args.quotedCredits !== undefined ? { quoted_credits: args.quotedCredits } : {}),
  };
}

/**
 * The confirm card's line for a single-division (Phase A) run.
 *
 * Split out of `BriefStep` and exported because this — not the arithmetic — is
 * where a client/server price divergence actually comes from: `quoteRun` is
 * shared, so the only way the two sides can disagree is by being handed
 * different `RungInput`s. Keeping it pure means the agreement is testable.
 */
export function scheduleQuoteLines(
  divisionId: string,
  brief: Pick<AiBriefContext, "movableFixtures" | "activeEntrants" | "courts">,
  mode: AiMode,
  scope: AiScope | undefined,
  rung: number | null,
): QuoteCardLine[] {
  return [
    {
      key: divisionId,
      label: null,
      input: {
        movableFixtures: movableForRun(brief.movableFixtures, mode, scope).length,
        entrants: brief.activeEntrants,
        courts: brief.courts.length,
      },
      chosen: rung,
    },
  ];
}

/**
 * The client's mirror of the OFFICIALS pack's sizing inputs
 * (officials-ai.ts:163-176 for the fixture selection, :1110-1116 for the three
 * numbers it prices on).
 *
 * The pack holds every division fixture that has a time — taking the dry-run
 * `schedule` (Phase A's proposal) as an override over the persisted slot — and
 * is not already decided. Its entrant and court counts are the DISTINCT values
 * across exactly those fixtures, not the division's totals.
 *
 * Pure and exported so the agreement with the server is testable without React.
 */
export function officialsQuoteInput(
  fixtures: AiConsoleFixture[],
  placements: { fixture_id: string; scheduled_at: string; court_label: string }[],
): { movableFixtures: number; entrants: number; courts: number } {
  const override = new Map(placements.map((p) => [p.fixture_id, p] as const));
  const included = fixtures
    .map((f) => {
      const ov = override.get(f.id);
      return { f, at: ov?.scheduled_at ?? f.scheduled_at, court: ov?.court_label ?? f.court_label };
    })
    .filter((x) => x.at !== null && x.f.status !== "decided");
  const entrants = new Set(
    included.flatMap((x) => [x.f.home_entrant_id, x.f.away_entrant_id]).filter((e) => e !== null),
  );
  const courts = new Set(included.map((x) => x.court).filter((c) => c !== null));
  return { movableFixtures: included.length, entrants: entrants.size, courts: courts.size };
}

/**
 * Client kill switch, mirroring the server "ai-scheduling" flag. Fail-open: only
 * an explicit `false` from PostHog hides the entry point — an unconfigured,
 * still-loading, or undefined flag all read as enabled, so a flag outage never
 * pulls a paid feature (schedule-ai.ts evaluates the same flag with fallback:
 * true). There is no existing PostHog client-flag hook in the app, so this is
 * the pattern the board reads it by.
 */
export function useAiSchedulingEnabled(): boolean {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    if (!posthog.__loaded) return;
    const sync = () => setDisabled(posthog.isFeatureEnabled("ai-scheduling") === false);
    sync(); // flags may already be cached from an earlier load
    return posthog.onFeatureFlags(sync); // returns an unsubscribe
  }, []);
  return !disabled;
}

const STEPS: AiStep[] = ["brief", "schedule", "officials", "apply"];

/** The officials policy the console runs Phase B with when the division has no
 *  saved one (none is persisted today — see the `officialsPolicy` prop). Mirrors
 *  the officials panel's auto-assign defaults ({ roles: ["referee"], … }) so the
 *  free solver draft matches what an organiser gets from that panel. */
const DEFAULT_OFFICIALS_POLICY: NonNullable<AiPlanRequest["officials_policy"]> = {
  roles: ["referee"],
  poolLock: false,
  blockStay: true,
  fairness: "tournament",
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

/** A step is "done" (teal) once it has produced its artifact. */
function stepDone(state: AiConsoleState, step: AiStep): boolean {
  switch (step) {
    case "brief":
      return state.schedulePlan !== null;
    case "schedule":
      return state.schedulePlan !== null && (state.step === "officials" || state.step === "apply");
    case "officials":
      return state.officialsPlan !== null;
    case "apply":
      return state.run === "applied";
  }
}

// The server code aiErrorKey sharpens on. A 402 paywall's envelope `code` is the
// generic "PAYMENT_REQUIRED" — the specific key rides in `extra.feature_key` (an
// empty AI wallet → "ai.credits", a save-point cap → "schedule.checkpoints.max"),
// so prefer the feature key and fall back to the typed code (a 422's
// AI_PLAN_TOO_LARGE). This mirrors ai-apply.ts's `featureKeyOf(err) ?? codeOf(err)`
// precedence; they don't collide (a 402 carries feature_key, a 422 does not).
function aiErrorCodeOf(err: unknown): string | undefined {
  if (!(err instanceof ApiV1Error)) return undefined;
  return typeof err.extra.feature_key === "string" ? err.extra.feature_key : err.code;
}

// Re-export so the board imports the ghost/diff fixture shape from one place.
export type { AiConsoleFixture } from "./ai-diff";

export function AiConsole({
  divisionId,
  expectedSeq,
  aiAllowed,
  scheduleFrozen,
  currency,
  brief,
  fixtures,
  officialsPolicy,
  prefillRepair,
  onClose,
  onApplied,
  onRefetch,
  onProposalChange,
  onPulse,
}: {
  divisionId: string;
  /** The division seq the board rendered at — the optimistic-concurrency token
   *  the AI apply carries (409 SEQ_CONFLICT on a stale board → re-run as refine). */
  expectedSeq: number;
  /** Client-side entitlement read (server prop) — false renders the paywall
   *  inside the dock with no network call. */
  aiAllowed: boolean;
  /** The division's schedule lock. A frozen board rejects every apply
   *  (applySchedule, 422), so a run could only ever produce a proposal the
   *  organiser is blocked from using — the server refuses with 409
   *  SCHEDULE_LOCKED, and this stops the button offering it in the first place. */
  scheduleFrozen: boolean;
  /** The org's locked billing currency — the out-of-credits recovery block (A6)
   *  prices its Buy-credits pack ladder in it. */
  currency: Currency;
  /** Live brief inputs derived by the board (pre-flight card + chip pickers). */
  brief: AiBriefContext;
  /** This division's current fixtures (before any proposal) — powers the diff
   *  panel's from→to provenance and the grid ghosts. */
  fixtures: AiConsoleFixture[];
  /** A saved officials AssignPolicy, if the division has one — sent with the run
   *  for a dry coverage preview (§2). No persisted policy source exists today
   *  (the officials/auto flow composes it ad-hoc from unsaved UI state), so the
   *  board leaves this undefined and the field is omitted; the seam is ready for
   *  when a policy is persisted. */
  officialsPolicy?: NonNullable<AiPlanRequest["officials_policy"]>;
  /** Opened from the repair nudge (Task 16): pre-arm repair mode + the disrupted
   *  scope on mount so the brief step lands pre-scoped. Undefined/null on a plain
   *  open (the launch button), leaving the console in its default generate flow. */
  prefillRepair?: AiScope | null;
  onClose: () => void;
  /** Called after a successful apply (and after an Undo) so the board refetches
   *  and the ghosts resolve to the applied — or reverted — state. */
  onApplied?: () => void;
  /** Called after a SEQ_CONFLICT so the board refetches the fresh schedule + seq
   *  behind the "re-run as refine" affordance. */
  onRefetch?: () => void;
  /** Notifies the board of the current proposal (or null) so it can paint the
   *  grid ghosts; fired on each RUN_DONE and cleared on unmount. */
  onProposalChange?: (plan: AiPlanResponse | null) => void;
  /** Fired when the trace flags a repair — the board pulses these fixture ids
   *  red on the grid for ~1.5s (design §0.3). */
  onPulse?: (fixtureIds: string[]) => void;
}) {
  const msg = useMsg();
  const pathname = usePathname();
  const [state, dispatch] = useReducer(aiConsoleReducer, initialAiConsoleState);
  // Opened from the repair nudge (Task 16): pre-arm repair mode + the disrupted
  // scope once on mount. The board conditionally renders the console, so mount
  // means open; the ref guards against re-dispatching if the prop identity
  // changes while it stays open. The brief step then shows repair mode active +
  // the scope chip, and the run carries state.scope.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefillRepair && !prefilledRef.current) {
      prefilledRef.current = true;
      dispatch({ type: "PREFILL_REPAIR", scope: prefillRepair });
    }
  }, [prefillRepair]);
  // Chip wishes live at the console level so they survive step navigation; the
  // instruction is always compileWishes(wishes) + preserved free text.
  const [wishes, setWishes] = useState<Wish[]>([]);
  // Phase B (officials) wishes — a separate list so switching steps never mixes
  // the two phases' chips.
  const [officialsWishes, setOfficialsWishes] = useState<OfficialsWish[]>([]);
  // Fetched once on open (design/v4/03): officials roster size (pre-flight) and
  // the last AI-sourced apply (recall strip). Neither bloats the board payload.
  // Full roster (id + display name) — the pre-flight count, the officials-grid
  // name resolution, and the "{official} only …" wish picker all read it. Kept
  // out of the board's initial payload; fetched once on open (gap 15).
  const [roster, setRoster] = useState<OfficialsRosterEntry[] | null>(null);
  const [lastRun, setLastRun] = useState<AiLastResult | null>(null);
  // The division's current full scheduling config (incl. constraints, which the
  // board's slimmer settings prop drops) — the apply step needs it to overlay the
  // ticked rule suggestions and PUT the whole config back (§7). Fetched once here
  // rather than widening the board payload.
  const [settings, setSettings] = useState<{ config: ScheduleConfig; tz: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiV1<{ id: string; display_name: string; role_keys: string[] }[]>("/api/v1/officials")
      .then((r) => !cancelled && setRoster(r.map((o) => ({ id: o.id, name: o.display_name }))))
      .catch(() => !cancelled && setRoster([]));
    apiV1<AiLastResult>(`/api/v1/divisions/${divisionId}/schedule/ai-last`)
      .then((r) => !cancelled && setLastRun(r))
      .catch(() => {});
    apiV1<{ config: ScheduleConfig; tz: string }>(`/api/v1/divisions/${divisionId}/schedule-settings`)
      .then((r) => !cancelled && setSettings({ config: r.config, tz: r.tz }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [divisionId]);
  const rosterCount = roster?.length ?? null;

  // Apply step (Task 15): the in-flight flag drives the button spinner without
  // touching the run state (so `busy`'s plan-run gating stays independent); the
  // outcome carries the before-ai checkpoint id that powers Undo.
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyOutcome | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);

  // Chips ↔ instruction: re-derive the compiled prefix, keep the free text.
  const applyWishes = useCallback(
    (next: Wish[]) => {
      const free = deriveFreeText(state.instruction, compileWishes(wishes));
      setWishes(next);
      dispatch({ type: "SET_INSTRUCTION", value: joinNonEmpty(compileWishes(next), free) });
    },
    [state.instruction, wishes],
  );
  // Reuse a last run or tap a preset: the whole textarea becomes that text and
  // the chips reset (so nothing re-prepends over it).
  const fillInstruction = useCallback((value: string) => {
    setWishes([]);
    dispatch({ type: "SET_INSTRUCTION", value });
  }, []);

  // Officials chips ↔ officials instruction — same derive-prefix pattern, on the
  // separate officialsInstruction field.
  const applyOfficialsWishes = useCallback(
    (next: OfficialsWish[]) => {
      const free = deriveFreeText(state.officialsInstruction, compileOfficialsWishes(officialsWishes));
      setOfficialsWishes(next);
      dispatch({
        type: "SET_INSTRUCTION",
        officials: true,
        value: joinNonEmpty(compileOfficialsWishes(next), free),
      });
    },
    [state.officialsInstruction, officialsWishes],
  );

  const preflight: PreflightInput = {
    divisionId,
    courts: brief.courts.length,
    windows: brief.windows,
    blackouts: brief.blackouts,
    constraintsSet: brief.constraintsSet,
    movable: brief.movableFixtures.length,
    pinned: brief.pinned,
    officials: rosterCount,
    officialsBlackout: brief.officialsWithBlackout,
    settingsHref: `${pathname}?tab=settings`,
    officialsHref: `${pathname}?tab=officials`,
  };
  // Instruction that produced the on-screen proposal — lets a refine turn send
  // the right `prior.instruction` when it round-trips the previous assignments.
  const priorInstruction = useRef("");
  // Phase B's equivalent lives in the REDUCER (`officialsPriorInstruction`),
  // not in a ref here: the officials confirm card prices the adopt path off it,
  // so it is state the render depends on, and a ref written inside an async
  // callback is both unobservable to the render and untestable without driving
  // a network round-trip. `OFFICIALS_DONE` records it with the plan it belongs
  // to. Whether that proposal had a prior stays local (grid tone only).
  // State, not a ref: it drives the `hadPrior` prop read during render
  // (OfficialsStep below) — react-hooks/refs correctly flags a ref read at
  // render time, since a ref mutation alone doesn't schedule the re-render
  // that would pick it up. The `dispatch({ type: "RUN_START" })` right after
  // the write already forces a render on every path that sets it, so this is
  // a same-render swap, not a new one.
  const [officialsHadPrior, setOfficialsHadPrior] = useState(false);
  // #385/#387: the SERVER's rung config, and the quotes the two confirm
  // surfaces are showing. The run bodies send those numbers so the server can
  // say whether what it charged is what the organiser was promised.
  const rungConfig = useRungConfig();
  const officialsAutoStarted = useRef(false);
  // Cancel any in-flight run on close/unmount (the board conditionally renders
  // the dock, so unmount cleanup covers close too) — its rejection is ignored.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const busy = state.run === "running" || state.run === "flagged";

  // Board callbacks held by ref so the unmount cleanup + proposal mirror can fire
  // the latest without listing them as deps. Synced in an effect (never during
  // render) so a changed callback can't cause a stale update.
  const onProposalRef = useRef(onProposalChange);
  const onPulseRef = useRef(onPulse);
  useEffect(() => {
    onProposalRef.current = onProposalChange;
    onPulseRef.current = onPulse;
  });
  // Mirror the current proposal to the board (grid ghosts); clear it on unmount
  // so closing the console wipes the overlay.
  useEffect(() => {
    onProposalRef.current?.(state.schedulePlan);
  }, [state.schedulePlan]);
  useEffect(() => () => onProposalRef.current?.(null), []);
  // A fresh animation per run — increments so AiTrace remounts and replays.
  const [traceNonce, setTraceNonce] = useState(0);
  const [officialsTraceNonce, setOfficialsTraceNonce] = useState(0);

  // W5 (#400) — stage 1 only. Compiles the sentence, spends no credit and makes
  // no architect call, so the organiser can read the rules before paying to run
  // against them. Declining the result is a pure client action (PREVIEW_DISMISS)
  // and fires no request at all: that is the entire gate.
  const preview = useCallback(async () => {
    const instruction = state.instruction.trim();
    // `scheduleFrozen` is checked HERE, not only on the button's `disabled`
    // attribute: a disabled prop is a hint to a pointer, and this request is not
    // weightless — it takes a rate-limit slot and runs an affordability check
    // against a run the server would refuse with 409 SCHEDULE_LOCKED anyway.
    // Same reasoning as the confirm gate inside `run` below (#400 Task 6b).
    if (instruction.length < 3 || busy || scheduleFrozen || state.preview.status === "loading") {
      return;
    }
    dispatch({ type: "PREVIEW_START" });
    try {
      const compiled = await apiV1<AiParsePreviewResponse>(
        `/api/v1/divisions/${divisionId}/schedule/ai-preview`,
        {
          method: "POST",
          // The SAME rung the confirm will run at, so the affordability refusal
          // prices the run that is actually on offer.
          json: {
            instruction,
            ...(state.rung !== null && isRung(state.rung) ? { rung: state.rung } : {}),
          },
        },
      );
      dispatch({ type: "PREVIEW_READY", preview: compiled });
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : 0;
      const key = aiErrorKey(status, aiErrorCodeOf(err));
      dispatch({ type: "PREVIEW_ERROR", error: { status, message: msg(key), key } });
    }
  }, [busy, divisionId, msg, scheduleFrozen, state.instruction, state.preview.status, state.rung]);

  const run = useCallback(async (opts?: { mode?: AiMode }) => {
    const instruction = state.instruction.trim();
    if (instruction.length < 3 || busy) return;
    // The confirm gate, enforced where the request is made rather than only on
    // the button that makes it. `canRun` is the reducer's own predicate, so the
    // card, the button and this guard cannot disagree about whether the
    // organiser has agreed to anything.
    //
    // Scoped to the brief step on purpose: the seq-conflict recovery
    // (`reRunAsRefine`) re-runs from the apply step over a proposal that was
    // already previewed and paid for, and has no brief in front of it to
    // confirm.
    if (state.step === "brief" && !canRun(state)) return;
    // The seq-conflict recovery re-runs Phase A as a refine over the current
    // proposal regardless of the mode toggle's async state — an explicit override
    // wins over state.mode for both the request mode and the prior round-trip.
    const mode = opts?.mode ?? state.mode;
    abortRef.current?.abort(); // cancel a prior in-flight run
    const ac = new AbortController();
    abortRef.current = ac;
    setTraceNonce((n) => n + 1); // fresh trace animation for this run
    dispatch({ type: "RUN_START" });
    const body = schedulePlanBody(state, {
      instruction,
      mode,
      // #387: the price the brief step is showing. Built from the SAME pure
      // `scheduleQuoteLines` + `quoteFor` pair the card renders — the whole
      // point of this field is that it is the card's number, so recomputing it
      // a second way here would make it measure nothing.
      quotedCredits: quoteFor(scheduleQuoteLines(divisionId, brief, mode, state.scope, state.rung), {
        weights: rungConfig.scheduling,
      }).credits,
      // A dry officials-coverage preview rides along only when the division has a
      // saved policy (none is persisted today, so this is omitted — see the prop).
      officialsPolicy,
      prior:
        mode === "refine" && state.schedulePlan && priorInstruction.current
          ? {
              instruction: priorInstruction.current,
              assignments: state.schedulePlan.proposal.map((p) => ({
                fixture_id: p.fixture_id,
                scheduled_at: p.scheduled_at,
                court_label: p.court_label,
              })),
            }
          : null,
    });
    try {
      const plan = await apiV1<AiPlanResponse>(
        `/api/v1/divisions/${divisionId}/schedule/ai-plan`,
        { method: "POST", json: body, signal: ac.signal },
      );
      priorInstruction.current = instruction;
      // A new schedule invalidates the officials draft (reducer clears the plan);
      // reset the auto-run latch so the officials step re-solves over the new
      // times on next entry rather than showing stale assignments.
      officialsAutoStarted.current = false;
      dispatch({ type: "RUN_DONE", plan });
    } catch (err) {
      // A cancelled run is not an error — the console is closing or superseded.
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      // Map the status (+ code) to a localized line; never render raw server text.
      // Carry the copy key too — the render enriches an `ai.credits` out-of-credits
      // key into the A6 recovery block (buy / upgrade / auto-topup).
      const status = err instanceof ApiV1Error ? err.status : 0;
      const key = aiErrorKey(status, aiErrorCodeOf(err));
      dispatch({ type: "RUN_ERROR", error: { status, message: msg(key), key } });
    }
    // `state` whole, not a field list: the body builder reads the state object
    // itself (so a call site cannot hand it the wrong phase's rung), which means
    // a field list would go stale the moment the builder reads a new one.
  }, [brief, busy, divisionId, msg, officialsPolicy, rungConfig, state]);

  // Phase B run. Empty instruction + no prior = the zero-token solver draft (the
  // auto-run on first entry); a non-empty instruction plans with the LLM; a
  // `prior` refines / round-trips the previous (or a locally patched) proposal.
  // It sends the Phase A proposal's dry-run times as `schedule` so officials are
  // assigned over the *proposed* board — ai-plan's own empty-instruction path is
  // the zero-token solver (usecase runOfficialsAiPlan), and unlike the free
  // /officials/auto route it accepts those times and covers newly placed fixtures.
  const runOfficials = useCallback(
    async (opts: { instruction: string; priorAssignments?: AiOfficialsPlanResponse["assignments"] }) => {
      if (busy || !state.schedulePlan) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOfficialsTraceNonce((n) => n + 1);
      setOfficialsHadPrior(Boolean(opts.priorAssignments));
      dispatch({ type: "RUN_START" });
      const schedule = state.schedulePlan.proposal.map((p) => ({
        fixture_id: p.fixture_id,
        scheduled_at: p.scheduled_at,
        court_label: p.court_label,
      }));
      // Phase B's rung is read by the builder from `officialsRung` — never
      // passed in, so this call site cannot hand it Phase A's.
      // #387: the officials card's own price. `freeDraft` is the SERVER's own
      // predicate — `officials-ai.ts` takes `freeDraftQuote` iff the sent
      // instruction is empty — and both spend paths (re-plan, adopt) supply
      // that string themselves, so asking it of `opts.instruction` asks the
      // question the server will ask of this very request.
      const quotedCredits = quoteFor(
        [
          {
            key: "officials",
            label: null,
            input: officialsQuoteInput(fixtures, schedule),
            chosen: state.officialsRung,
          },
        ],
        { weights: rungConfig.officials, freeDraft: opts.instruction.trim() === "" },
      ).credits;
      const officialsBody = officialsPlanBody(state, {
        instruction: opts.instruction,
        quotedCredits,
        schedule,
        policy: officialsPolicy ?? DEFAULT_OFFICIALS_POLICY,
        priorAssignments: opts.priorAssignments,
      });
      try {
        const plan = await apiV1<AiOfficialsPlanResponse>(
          `/api/v1/divisions/${divisionId}/officials/ai-plan`,
          { method: "POST", json: officialsBody, signal: ac.signal },
        );
        // Recorded from the BODY that was actually sent, not from `opts`, so
        // the brief we remember is by construction the brief the server was
        // asked for. One action records it with the plan it produced, so the
        // two cannot drift apart either.
        dispatch({ type: "OFFICIALS_DONE", plan, instruction: officialsBody.instruction });
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        const status = err instanceof ApiV1Error ? err.status : 0;
        const key = aiErrorKey(status, aiErrorCodeOf(err));
        dispatch({ type: "RUN_ERROR", error: { status, message: msg(key), key } });
      }
    },
    // See the note on `run`'s deps — the body builder reads `state` itself.
    [busy, divisionId, fixtures, msg, officialsPolicy, rungConfig, state],
  );

  // Auto-run the free solver draft the first time the organiser reaches the
  // officials step so it is never blank (design/v4/03 §3). Fires once per open;
  // refines are manual. On error the plan stays null and the ref stays set, so
  // it never retries in a loop — the inline error offers Re-plan.
  useEffect(() => {
    if (
      state.step === "officials" &&
      state.officialsPlan === null &&
      state.schedulePlan !== null &&
      !officialsAutoStarted.current &&
      !busy
    ) {
      officialsAutoStarted.current = true;
      void runOfficials({ instruction: "" });
    }
  }, [state.step, state.officialsPlan, state.schedulePlan, busy, runOfficials]);

  // ---------------------------------------------------- apply orchestration (T15)
  // Chain the existing apply rails: a before-ai checkpoint, the schedule apply(s)
  // (stage-grouped, source "ai" + audit), the officials apply, then the ticked
  // rule PUT — all in ai-apply's pure `applyAiPlans`. Excluded (unticked) blockers
  // drop out of BOTH payloads there. This handler builds the payloads from the
  // console state and maps the outcome onto the reducer + board refetch.
  const doApply = useCallback(
    async (includeOfficials: boolean, tickedSuggestions: SuggestionKey[]) => {
      const plan = state.schedulePlan;
      if (!plan || applying) return;
      dispatch({ type: "APPLY_START" });
      setApplying(true);
      setUndone(false);
      const stageOf = new Map(fixtures.map((f) => [f.id, f.stage_id]));
      const scheduleAudit = {
        instruction: (priorInstruction.current || state.instruction).slice(0, 500),
        summary: plan.summary.slice(0, 600),
        model: AI_APPLY_MODEL,
        repair_rounds: plan.usage.repair_rounds,
      };
      const officials =
        includeOfficials && state.officialsPlan
          ? {
              assignments: state.officialsPlan.assignments.map((a) => ({
                fixture_id: a.fixtureId,
                official_id: a.officialId,
                role_key: a.roleKey,
                locked: a.locked ?? false,
              })),
              audit: {
                instruction: state.officialsPriorInstruction.slice(0, 500),
                summary: state.officialsPlan.summary.slice(0, 600),
                model: AI_APPLY_MODEL,
                repair_rounds: state.officialsPlan.usage.repair_rounds,
              },
            }
          : null;
      const suggestions =
        tickedSuggestions.length > 0 && settings && plan.constraint_suggestions
          ? {
              config: mergeConstraintSuggestions(settings.config, plan.constraint_suggestions, tickedSuggestions),
              tz: settings.tz,
            }
          : null;
      let result: ApplyOutcome;
      try {
        result = await applyAiPlans({
          divisionId,
          expectedSeq,
          scheduleAssignments: plan.proposal.map((p) => ({
            fixture_id: p.fixture_id,
            scheduled_at: p.scheduled_at,
            court_label: p.court_label,
            stage_id: stageOf.get(p.fixture_id) ?? "",
          })),
          scheduleAudit,
          officials,
          excludedFixtureIds: state.excludedFixtures,
          suggestions,
        });
      } catch {
        result = { schedule: "error", officials: "skipped", checkpointId: null };
      }
      setApplying(false);
      setApplyResult(result);
      if (result.schedule === "applied") {
        dispatch({ type: "APPLIED" });
        onApplied?.(); // board refetch → ghosts resolve to the applied state
      } else if (result.schedule === "seq_conflict") {
        dispatch({ type: "APPLY_SEQ_CONFLICT" });
        onRefetch?.(); // pull the fresh board behind the re-run affordance
      } else {
        // Map the real failure (checkpoint 402 save-point cap, schedule 422/409,
        // …) through aiErrorKey instead of the flat generic; the outcome now
        // carries the status+code applyErrorKey needs.
        const key = applyErrorKey(result);
        dispatch({
          type: "APPLY_ERROR",
          error: { status: result.errorStatus ?? 0, message: msg(key), key },
        });
      }
    },
    [
      applying,
      divisionId,
      expectedSeq,
      fixtures,
      msg,
      onApplied,
      onRefetch,
      settings,
      state.excludedFixtures,
      state.instruction,
      state.officialsPlan,
      // The officials audit line records the brief the assignments came from.
      state.officialsPriorInstruction,
      state.schedulePlan,
    ],
  );

  // Discard: abandon the verified proposal from the apply step (the run's abandon
  // signal) and close the dock — the board clears the ghosts on unmount.
  const discard = useCallback(() => {
    track(EVENTS.AI_PLAN_DISCARDED, { division_id: divisionId });
    onClose();
  }, [divisionId, onClose]);

  // Undo: one tap restores the before-ai checkpoint the apply created, then
  // refetches so the board shows the reverted schedule.
  const undo = useCallback(async () => {
    const checkpointId = applyResult?.checkpointId;
    if (!checkpointId || undoing) return;
    setUndoing(true);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/restore`, {
        method: "POST",
        json: { checkpoint_id: checkpointId, confirm: true },
      });
      setUndone(true);
      onApplied?.();
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : 0;
      const key = aiErrorKey(status, aiErrorCodeOf(err));
      dispatch({ type: "APPLY_ERROR", error: { status, message: msg(key), key } });
    } finally {
      setUndoing(false);
    }
  }, [applyResult, divisionId, msg, onApplied, undoing]);

  // Re-run as refine: fold the organiser's proposal into a fresh Phase A pass over
  // the just-refetched board (prior = the current proposal). The mode override
  // wins over the toggle's async state so this is a single tap.
  const reRunAsRefine = useCallback(() => {
    setApplyResult(null);
    dispatch({ type: "SET_MODE", mode: "refine" });
    void run({ mode: "refine" });
  }, [run]);

  const body = aiAllowed ? (
    <div className="space-y-4">
      <Stepper state={state} onGoto={(step) => dispatch({ type: "GOTO_STEP", step })} msg={msg} />
      {state.step === "brief" && (
        <BriefStep
          state={state}
          dispatch={dispatch}
          run={run}
          preview={preview}
          busy={busy}
          msg={msg}
          currency={currency}
          brief={brief}
          preflight={preflight}
          wishes={wishes}
          onWishes={applyWishes}
          onFill={fillInstruction}
          lastRun={lastRun}
          scheduleFrozen={scheduleFrozen}
        />
      )}
      {state.step === "schedule" && (
        <ScheduleStep
          state={state}
          dispatch={dispatch}
          msg={msg}
          fixtures={fixtures}
          courts={brief.courts.length}
          busy={busy}
          traceNonce={traceNonce}
          onPulse={(ids) => onPulseRef.current?.(ids)}
        />
      )}
      {state.step === "officials" && (
        <OfficialsStep
          state={state}
          dispatch={dispatch}
          currency={currency}
          fixtures={fixtures}
          roster={roster ?? []}
          policyRoles={(officialsPolicy ?? DEFAULT_OFFICIALS_POLICY).roles}
          hadPrior={officialsHadPrior}
          busy={busy}
          traceNonce={officialsTraceNonce}
          wishes={officialsWishes}
          onWishes={applyOfficialsWishes}
          onReplan={() =>
            runOfficials({
              instruction: state.officialsInstruction.trim(),
              priorAssignments: state.officialsPlan?.assignments,
            })
          }
          onAdopt={(fixtureId, roleKey, candidateId) => {
            const cur = state.officialsPlan?.assignments ?? [];
            const patched = [
              ...cur.filter((a) => !(a.fixtureId === fixtureId && a.roleKey === roleKey)),
              { fixtureId, officialId: candidateId, roleKey, locked: false },
            ];
            void runOfficials({ instruction: state.officialsPriorInstruction, priorAssignments: patched });
          }}
          onPulse={(ids) => onPulseRef.current?.(ids)}
        />
      )}
      {state.step === "apply" && (
        <ApplyStep
          state={state}
          plan={state.schedulePlan}
          currency={currency}
          fixtures={fixtures}
          settingsReady={settings !== null}
          applying={applying}
          applyResult={applyResult}
          undoing={undoing}
          undone={undone}
          onApply={doApply}
          onDiscard={discard}
          onUndo={undo}
          onReRunRefine={reRunAsRefine}
          msg={msg}
        />
      )}
    </div>
  ) : (
    <UpgradeGate feature="scheduling.ai" />
  );

  return (
    <aside
      role="region"
      aria-label={msg("board.ai.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="ai-console fixed inset-x-0 bottom-0 z-40 max-h-[82vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-auto sm:max-h-[80vh] sm:w-[27rem] sm:rounded-2xl"
    >
      {/* Header — the AI wash + sparkle live here and nowhere else. */}
      <div className="relative overflow-hidden rounded-t-2xl border-b border-slate-200 bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-3 text-white">
        <div className="sheet-handle bg-white/40 sm:hidden" aria-hidden />
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-lg leading-none">✦</span>
          <h2 className="text-sm font-semibold tracking-tight">{msg("board.ai.title")}</h2>
          <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {msg("board.ai.beta")}
          </span>
          <PlanBadge feature="scheduling.ai" />
          <button
            type="button"
            onClick={onClose}
            aria-label={msg("board.ai.close")}
            className="ml-auto grid h-7 w-7 place-items-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-white/85">{msg("board.ai.subtitle")}</p>
      </div>

      <div className="p-4">{body}</div>
      <p className="sticky bottom-0 border-t border-slate-100 bg-white/95 px-4 py-2 text-[11px] text-slate-500 backdrop-blur-sm">
        {msg("board.ai.disclaimer")}
      </p>
    </aside>
  );
}

// ------------------------------------------------------------------ stepper
function Stepper({
  state,
  onGoto,
  msg,
}: {
  state: AiConsoleState;
  onGoto: (step: AiStep) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const labels: Record<AiStep, string> = {
    brief: msg("board.ai.step.brief"),
    schedule: msg("board.ai.step.schedule"),
    officials: msg("board.ai.step.officials"),
    apply: msg("board.ai.step.apply"),
  };
  // Downstream steps are only reachable once a proposal exists (reducer-gated);
  // reflect that in the affordance so a disabled dot never lies.
  const reachable = (step: AiStep) => step === "brief" || state.schedulePlan !== null;
  return (
    <ol className="flex items-center" aria-label={msg("board.ai.stepperAria")}>
      {STEPS.map((step, i) => {
        const current = state.step === step;
        const done = !current && stepDone(state, step);
        const canGo = reachable(step) && !current;
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => canGo && onGoto(step)}
              disabled={!canGo}
              aria-current={current ? "step" : undefined}
              className="group flex flex-col items-center gap-1 text-center disabled:cursor-default"
              title={labels[step]}
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ring-1 transition ${
                  current
                    ? "bg-violet-600 text-white ring-violet-600"
                    : done
                      ? "bg-teal-500 text-white ring-teal-500"
                      : canGo
                        ? "bg-white text-slate-500 ring-slate-300 group-hover:ring-violet-400"
                        : "bg-slate-50 text-slate-300 ring-slate-200"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[11px] font-medium ${
                  current ? "text-violet-700" : done ? "text-teal-600" : "text-slate-400"
                }`}
              >
                {labels[step]}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={`mx-1 h-px flex-1 self-start mt-3.5 ${done ? "bg-teal-300" : "bg-slate-200"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// -------------------------------------------------------------- brief step
const MODES: AiMode[] = ["generate", "refine", "repair"];

/** Exported for the render tests, on the same terms as `ScheduleStep`: what the
 *  brief step SAYS in each of its states — a failed compile above all — is only
 *  observable by rendering it, and the console's own suites drive callbacks
 *  rather than markup. */
export function BriefStep({
  state,
  dispatch,
  run,
  preview,
  busy,
  msg,
  currency,
  brief,
  preflight,
  wishes,
  onWishes,
  onFill,
  lastRun,
  scheduleFrozen,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  run: () => void;
  /** W5 (#400) — compile the instruction without spending anything. */
  preview: () => void;
  busy: boolean;
  /** Frozen board — the server refuses the run with 409 SCHEDULE_LOCKED, so
   *  never offer it. */
  scheduleFrozen: boolean;
  msg: ReturnType<typeof useMsg>;
  currency: Currency;
  brief: AiBriefContext;
  preflight: PreflightInput;
  wishes: Wish[];
  onWishes: (next: Wish[]) => void;
  onFill: (value: string) => void;
  lastRun: AiLastResult | null;
}) {
  const plural = usePlural();
  // #385: the CTA and the confirm card price through the SAME server-resolved
  // weights the card renders with. Letting `quoteFor` fall back to
  // `schedulingRungWeights()` here would put a defaults-priced number on the
  // button above a card priced on the overrides.
  const cfg = useRungConfig();
  const tooShort = state.instruction.trim().length < 3;
  const presetNums = [1, 2, 3] as const;
  // ONE line — the division being planned. The joint competition console
  // (#350) builds the same shape with one line per selected division; the card
  // switches layout on the count, so there is no second card to keep in sync.
  const quoteLines = scheduleQuoteLines(
    preflight.divisionId,
    brief,
    state.mode,
    state.scope,
    state.rung,
  );
  // The CTA's count comes from the SAME quote the card renders — pricing the
  // run twice is how a button and the card above it come to disagree. On a
  // frozen board the count is suppressed for the same reason the card is
  // hidden: there is no run to price, so naming a price would be quoting for
  // something that is not on offer.
  // W5 (#400). Three states, one button plus one card between them:
  //   nothing compiled  → "Check what this means" (spends nothing)
  //   compiled          → the receipt card, whose confirm starts the run
  //   fallback taken    → the ordinary run button, priced as always
  const checking = state.preview.status === "loading";
  // The compile round-trip failed. Read here and nowhere else, so the error
  // block and its label cannot come to different conclusions about which half
  // of the gate broke. Takes precedence over `run === "error"` on purpose: a
  // failed run followed by a failed check leaves BOTH set, and `state.error` is
  // then the check's (PREVIEW_ERROR wrote it last).
  const previewFailed = state.preview.status === "error";
  const cardVisible =
    !busy &&
    !scheduleFrozen &&
    state.preview.status === "ready" &&
    state.preview.data !== null &&
    !state.preview.asPreference;
  // Reads the reducer's own predicate — the button cannot come to a different
  // conclusion about whether the organiser has agreed to anything.
  const confirmed = canRun(state, { scheduleFrozen });
  const runAction = msg(`board.ai.run.${state.mode}` as MessageKey);
  const runLabel = scheduleFrozen
    ? runAction
    : msg("board.ai.quote.cta", {
        action: runAction,
        credits: plural("board.ai.quote.credits", quoteFor(quoteLines, { weights: cfg.scheduling }).credits),
      });
  return (
    <div className="space-y-3">
      {/* Run type */}
      <div role="group" aria-label={msg("board.ai.modeAria")} className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {MODES.map((m) => {
          // Refine adjusts an existing proposal, so it needs one first.
          const disabled = m === "refine" && state.schedulePlan === null;
          const active = state.mode === m;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled || busy}
              aria-pressed={active}
              onClick={() => dispatch({ type: "SET_MODE", mode: m })}
              title={disabled ? msg("board.ai.mode.refineTitle") : undefined}
              className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
                active ? "bg-white text-violet-700 shadow-sm" : "text-slate-500 hover:text-violet-700"
              }`}
            >
              {msg(`board.ai.mode.${m}` as MessageKey)}
            </button>
          );
        })}
      </div>

      {state.scope && (
        <p className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700">
          <span aria-hidden>◎</span>
          {msg("board.ai.scoped")}
        </p>
      )}

      {/* Generation budget — the same count the ai-plan quota gate enforces,
          so the number here never disagrees with a 402. Hidden when unlimited. */}
      {lastRun && lastRun.runs.max !== null && (
        <p
          className={`text-[11px] ${
            lastRun.runs.max - lastRun.runs.used <= 3 ? "font-medium text-amber-600" : "text-slate-500"
          }`}
        >
          {msg("board.ai.runsLeft", {
            left: Math.max(0, lastRun.runs.max - lastRun.runs.used),
            max: lastRun.runs.max,
          })}
        </p>
      )}

      {/* Last AI run — one tap refills the textarea (design/v4/03 §4). */}
      {lastRun?.last && <AiLastRun last={lastRun.last} onReuse={onFill} />}

      {/* Wish chips compile into the instruction below. */}
      <AiWishChips wishes={wishes} onChange={onWishes} entrants={brief.entrants} courts={brief.courts} />

      <div>
        <label htmlFor="ai-instruction" className="label">
          {msg("board.ai.instructionLabel")}
        </label>
        <textarea
          id="ai-instruction"
          className="input min-h-24 resize-y"
          value={state.instruction}
          disabled={busy}
          onChange={(e) => dispatch({ type: "SET_INSTRUCTION", value: e.target.value })}
          placeholder={msg("board.ai.instructionPlaceholder")}
        />
        <p className="mt-1 text-[11px] text-slate-500">{msg("board.ai.instructionHint")}</p>
      </div>

      {/* One-tap example presets for the active mode (02 §4). */}
      <div className="space-y-1">
        <span className="label mb-0">{msg("board.ai.preset.label")}</span>
        <div className="space-y-1">
          {presetNums.map((n) => {
            const text = msg(`board.ai.preset.${state.mode}.${n}` as MessageKey);
            return (
              <button
                key={n}
                type="button"
                disabled={busy}
                onClick={() => onFill(text)}
                className="block w-full rounded-md border border-slate-200 bg-slate-50/60 px-2.5 py-1 text-left text-[11px] leading-snug text-slate-600 transition hover:border-violet-300 hover:bg-white hover:text-violet-700 disabled:opacity-50"
              >
                {text}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pre-flight readiness — informational, never blocks the run. */}
      <AiPreflight {...preflight} />

      {/* What the run costs, and the budget the organiser is buying. Hidden on
          a frozen board: the run cannot happen, so quoting it would be a price
          for something that is not on offer. */}
      {!scheduleFrozen && (
        <AiQuoteCard
          lines={quoteLines}
          onChange={(_key, rung) => dispatch({ type: "SET_RUNG", rung })}
          msg={msg}
          busy={busy}
        />
      )}

      {/* One error surface for both halves of the gate.
          A failed COMPILE lands here too. `PREVIEW_ERROR` deliberately leaves
          `run` alone — that field describes the architect run, and a free
          compile never starts one — so gating this block on `run === "error"`
          alone silenced every preview failure (402, 409, 429, 5xx, offline):
          the spinner stopped and nothing was said. The preview is the cheap
          half of the gate, which makes its failures load-bearing, so it reuses
          the run's own idiom rather than a second one. Only the label changes,
          because the run is the one thing that did NOT happen. */}
      {state.error && (previewFailed || state.run === "error") && (
        state.error.key === "board.ai.error.outOfCredits" ? (
          <AiOutOfCredits currency={currency} />
        ) : (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="font-semibold">
              {msg(previewFailed ? "board.ai.preview.error.label" : "board.ai.errorLabel")}
            </span>{" "}
            {state.error.message}
            {/* The way out, stated: nothing was charged, the brief is still in
                the box above, and the check below can be taken again. */}
            {previewFailed && (
              <span className="mt-1 block text-red-600/90">
                {msg("board.ai.preview.error.free")}
              </span>
            )}
          </p>
        )
      )}

      {/* A frozen board rejects every apply, so a run could only ever produce a
          proposal the organiser is then blocked from using. Say so where the
          decision is made, rather than letting them spend a generation and
          several minutes to find out at Apply. */}
      {scheduleFrozen && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <span aria-hidden>❄</span>
          {msg("board.ai.frozen")}
        </p>
      )}

      {/* W5 (#400) — the confirm gate. The first click COMPILES the sentence
          (stage 1, no credit, no architect call) and the card below is the
          receipt for it; only the card's own confirm starts a chargeable run.
          Declining dispatches PREVIEW_DISMISS and fires no request, which is
          what makes "declining spends no credit" a fact rather than a claim.

          The card is withheld once the organiser has taken the preference
          fallback: they have already answered its question, and leaving it up
          would ask again. */}
      {cardVisible && state.preview.data && (
        <AiInstructionPreview
          preview={state.preview.data}
          credits={quoteFor(quoteLines, { weights: cfg.scheduling }).credits}
          onConfirm={run}
          onDismiss={() => dispatch({ type: "PREVIEW_DISMISS" })}
          onAsPreference={() => dispatch({ type: "PREVIEW_AS_PREFERENCE" })}
        />
      )}

      {!cardVisible && (
        <button
          type="button"
          onClick={confirmed ? run : preview}
          data-ai-stage={confirmed ? "run" : "check"}
          disabled={tooShort || busy || scheduleFrozen || checking}
          className="ai-run inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy || checking ? (
            <>
              <Spinner />
              {checking
                ? msg("board.ai.preview.checking")
                : state.run === "flagged"
                  ? msg("board.ai.flagged")
                  : msg("board.ai.running")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {confirmed ? runLabel : msg("board.ai.preview.check")}
            </>
          )}
        </button>
      )}
      {/* Below the button, not inside it: a per-second counter on a gradient
          fill would jitter the label, and gray would not read on violet.
          Mounted only while busy — the unmount is what resets the clock. */}
      {busy && <RunElapsed />}
    </div>
  );
}

// ----------------------------------------------------------- schedule step
/**
 * Compose the referee trace from the verified plan (design §0). There is no
 * server trace field, so the console narrates what the engine did from the
 * result: a draft/plan/verify spine, then — when a repair ran or conflicts
 * surfaced — flag lines (the caught conflicts, pulsed on the grid) and a repair
 * round, and finally either the mandated CLEAN line + Ready, or, when blocking
 * conflicts remain, a red "unresolved" tail (no clean, spine stays flagged).
 */
function buildScheduleTrace(
  plan: AiPlanResponse,
  courts: number,
  msg: ReturnType<typeof useMsg>,
): { events: TraceEvent[]; flaggedIds: string[] } {
  const events: TraceEvent[] = [];
  const node = (k: MessageKey) => events.push({ t: "step", text: msg(k) });
  const log = (text: string) => events.push({ t: "log", text });

  node("board.ai.trace.node.draft");
  log(msg("board.ai.trace.line.draft", { fixtures: plan.proposal.length, courts }));
  node("board.ai.trace.node.plan");
  log(msg("board.ai.trace.line.plan", { count: plan.proposal.length }));
  node("board.ai.trace.node.referee");
  log(msg("board.ai.trace.line.verify"));

  const conflicts = [...plan.blocking, ...plan.warnings];
  const flaggedIds = Array.from(new Set(conflicts.map((c) => c.fixtureId)));
  const repaired = plan.usage.repair_rounds > 0;

  if (repaired || conflicts.length > 0) {
    const shown = conflicts.slice(0, 3);
    if (shown.length > 0) {
      for (const c of shown) {
        events.push({ t: "flag", text: msg("board.ai.trace.line.flag", { what: c.detail || c.reason }) });
      }
    } else {
      events.push({ t: "flag", text: msg("board.ai.trace.line.flagGeneric") });
    }
    if (repaired) {
      node("board.ai.trace.node.repair");
      log(msg("board.ai.trace.line.repair", { rounds: plan.usage.repair_rounds }));
    }
  }

  if (plan.blocking.length > 0) {
    // Not clean — the engine could not fully verify; spine ends flagged.
    events.push({ t: "flag", text: msg("board.ai.trace.line.blockingRemain", { count: plan.blocking.length }) });
  } else {
    events.push({ t: "clean", text: msg("board.ai.trace.line.clean") });
    node("board.ai.trace.node.ready");
  }

  return { events, flaggedIds };
}

/** Exported for the render tests: its inputs are a raw plan and the board's
 *  fixtures, and everything worth pinning — what the review card counts, what
 *  it names — is derived from them, so calling it directly still pins the
 *  derivation rather than handing the component its own answer. */
export function ScheduleStep({
  state,
  dispatch,
  msg,
  fixtures,
  courts,
  busy,
  traceNonce,
  onPulse,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  msg: ReturnType<typeof useMsg>;
  fixtures: AiConsoleFixture[];
  courts: number;
  busy: boolean;
  traceNonce: number;
  onPulse: (ids: string[]) => void;
}) {
  const plan = state.schedulePlan;
  const { events, flaggedIds } = useMemo(
    () => (plan ? buildScheduleTrace(plan, courts, msg) : { events: [], flaggedIds: [] }),
    [plan, courts, msg],
  );
  // One array for the review card and its count — built here so the panel and
  // the number above it are the same list (#388). Before the early return: this
  // is a hook.
  const reviewRows = useMemo(() => (plan ? buildReviewRows(plan) : []), [plan]);
  if (!plan) return <Empty msg={msg} k="board.ai.schedule.empty" />;

  return (
    <div className="space-y-3">
      {/* The referee trace — the headline (§0). */}
      <AiTrace
        key={traceNonce}
        phase="schedule"
        events={events}
        running={busy}
        onFlag={() => onPulse(flaggedIds)}
      />

      {/* Summary + usage + coverage + the "why it did that" diff (§3/§5/§6). */}
      <AiDiffPanel
        plan={plan}
        fixtures={fixtures}
        excluded={state.excludedFixtures}
        onToggleExclude={(fixtureId) => dispatch({ type: "TOGGLE_EXCLUDE", fixtureId })}
      />

      {/* Everything the run flagged, could not place, or assumed — one card,
          one count (#388). It sits ABOVE the review note and the buttons
          because it is the last thing the organiser should read before
          choosing to apply, and below the diff because the diff is what
          happened and this is what to look at. */}
      <AiReviewPanel
        rows={reviewRows}
        fixtures={fixtures}
        onPulse={(ids) => onPulse(ids)}
      />

      <p className="text-[11px] text-slate-500">{msg("board.ai.schedule.reviewNote")}</p>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => dispatch({ type: "GOTO_STEP", step: "officials" })}
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.officials")}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "GOTO_STEP", step: "apply" })}
          className="btn btn-ghost px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.apply")}
        </button>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "SET_MODE", mode: "refine" });
            dispatch({ type: "GOTO_STEP", step: "brief" });
          }}
          className="btn btn-ghost ml-auto px-3 py-1.5 text-xs"
        >
          {msg("board.ai.next.refine")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- officials step
// Phase B — the officials review grid (design/v4/03 §3). Reachable only once a
// schedule plan exists (reducer-gated); the auto-run in the parent fills it with
// the free solver draft on first entry. The proposal's dry-run placements power
// the grid's times so it reads consistently with the schedule step.
export function OfficialsStep({
  state,
  dispatch,
  currency,
  fixtures,
  roster,
  policyRoles,
  hadPrior,
  busy,
  traceNonce,
  wishes,
  onWishes,
  onReplan,
  onAdopt,
  onPulse,
}: {
  state: AiConsoleState;
  dispatch: (a: Parameters<typeof aiConsoleReducer>[1]) => void;
  currency: Currency;
  fixtures: AiConsoleFixture[];
  roster: OfficialsRosterEntry[];
  policyRoles: string[];
  hadPrior: boolean;
  busy: boolean;
  traceNonce: number;
  wishes: OfficialsWish[];
  onWishes: (next: OfficialsWish[]) => void;
  onReplan: () => void;
  onAdopt: (fixtureId: string, roleKey: string, candidateId: string) => void;
  onPulse: (ids: string[]) => void;
}) {
  const placements = (state.schedulePlan?.proposal ?? []).map((p) => ({
    fixture_id: p.fixture_id,
    scheduled_at: p.scheduled_at,
    court_label: p.court_label,
  }));
  return (
    <AiOfficialsReview
      plan={state.officialsPlan}
      placements={placements}
      quoteInput={officialsQuoteInput(fixtures, placements)}
      rung={state.officialsRung}
      onRung={(rung) => dispatch({ type: "SET_OFFICIALS_RUNG", rung })}
      currency={currency}
      fixtures={fixtures}
      roster={roster}
      roles={policyRoles}
      hasPrior={hadPrior}
      busy={busy}
      traceNonce={traceNonce}
      error={state.run === "error" ? state.error : null}
      instruction={state.officialsInstruction}
      // The second spend path's instruction, so the card can ask the server's
      // own free/priced question of it. It must stay the SAME field `onAdopt`
      // sends as the run's `instruction` — hand the card anything else (a "",
      // a placeholder) and it will quote 1 credit for a run priced at 2-3.
      adoptInstruction={state.officialsPriorInstruction}
      onInstruction={(v) => dispatch({ type: "SET_INSTRUCTION", officials: true, value: v })}
      wishes={wishes}
      onWishes={onWishes}
      onReplan={onReplan}
      onAdopt={onAdopt}
      onBack={() => dispatch({ type: "GOTO_STEP", step: "schedule" })}
      onContinue={() => dispatch({ type: "GOTO_STEP", step: "apply" })}
      onPulse={onPulse}
    />
  );
}

// -------------------------------------------------------------- apply step
// The chained accept (Task 15): a "what applies" recap, the checked-by-default
// rule-suggestions checklist, then the three commit paths — apply schedule +
// officials, apply schedule only, or discard. The orchestration + outcome live
// in the parent (doApply / applyAiPlans); this step renders the pre-apply, the
// stale-board recovery (re-run as refine), the error, and the applied states.
function ApplyStep({
  state,
  plan,
  currency,
  fixtures,
  settingsReady,
  applying,
  applyResult,
  undoing,
  undone,
  onApply,
  onDiscard,
  onUndo,
  onReRunRefine,
  msg,
}: {
  state: AiConsoleState;
  plan: AiPlanResponse | null;
  currency: Currency;
  fixtures: AiConsoleFixture[];
  settingsReady: boolean;
  applying: boolean;
  applyResult: ApplyOutcome | null;
  undoing: boolean;
  undone: boolean;
  onApply: (includeOfficials: boolean, ticked: SuggestionKey[]) => void;
  onDiscard: () => void;
  onUndo: () => void;
  onReRunRefine: () => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const excluded = useMemo(() => new Set(state.excludedFixtures), [state.excludedFixtures]);
  const suggestKeys = useMemo(() => suggestionKeysOf(plan?.constraint_suggestions), [plan]);
  const [ticked, setTicked] = useState<Set<SuggestionKey>>(() => new Set(suggestKeys));

  if (!plan) return <Empty msg={msg} k="board.ai.schedule.empty" />;

  // Applied — the success toast + checkpoint banner, or the reverted state.
  if (state.run === "applied") {
    if (undone) {
      return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <span aria-hidden>⟲</span>
            {msg("board.ai.apply.reverted")}
          </p>
        </div>
      );
    }
    return <AppliedState outcome={applyResult} onUndo={onUndo} undoing={undoing} msg={msg} />;
  }

  const scheduleCount = plan.proposal.filter((p) => !excluded.has(p.fixture_id)).length;
  const officialsCount = state.officialsPlan
    ? state.officialsPlan.assignments.filter((a) => !excluded.has(a.fixtureId)).length
    : 0;
  const stale = state.run === "seq_conflict";

  // Stale board — the only path forward is a refine over the refetched schedule.
  if (stale) {
    return (
      <div className="space-y-3">
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <p className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden>⚠</span>
            {msg("board.ai.apply.staleTitle")}
          </p>
          <p className="mt-0.5 text-amber-700">{msg("board.ai.apply.stale")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReRunRefine}
            className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
          >
            <span aria-hidden>✦</span>
            {msg("board.ai.apply.reRunRefine")}
          </button>
          <button type="button" onClick={onDiscard} className="btn btn-ghost px-3 py-1.5 text-xs text-slate-500">
            {msg("board.ai.apply.discard")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{msg("board.ai.apply.lead")}</p>

      {/* What will apply — the recap before the commit. */}
      <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
        <p className="flex items-center gap-1.5 text-xs text-slate-700">
          <span aria-hidden className="h-2 w-2 rounded-full bg-teal-500" />
          {msg("board.ai.apply.willSchedule", { n: scheduleCount })}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-slate-700">
          <span aria-hidden className={`h-2 w-2 rounded-full ${officialsCount > 0 ? "bg-teal-500" : "bg-slate-300"}`} />
          {officialsCount > 0
            ? msg("board.ai.apply.willOfficials", { n: officialsCount })
            : msg("board.ai.apply.noOfficials")}
        </p>
        <p className="pt-0.5 text-[11px] text-slate-500">{msg("board.ai.apply.hint")}</p>
      </div>

      {/* Rule changes the architect inferred — checked by default, each optional. */}
      {suggestKeys.length > 0 && settingsReady && (
        <SuggestChecklist
          plan={plan}
          keys={suggestKeys}
          ticked={ticked}
          onToggle={(k) =>
            setTicked((prev) => {
              const next = new Set(prev);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              return next;
            })
          }
          msg={msg}
        />
      )}

      {state.run === "error" && state.error && (
        state.error.key === "board.ai.error.outOfCredits" ? (
          <AiOutOfCredits currency={currency} />
        ) : (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="font-semibold">{msg("board.ai.errorLabel")}</span> {state.error.message}
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled={applying || scheduleCount === 0}
          onClick={() => onApply(true, [...ticked])}
          className="ai-run inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? (
            <>
              <Spinner />
              {msg("board.ai.apply.applying")}
            </>
          ) : (
            <>
              <span aria-hidden>✦</span>
              {msg("board.ai.apply.both")}
            </>
          )}
        </button>
        <button
          type="button"
          disabled={applying || scheduleCount === 0}
          onClick={() => onApply(false, [...ticked])}
          className="btn btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {msg("board.ai.apply.scheduleOnly")}
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={onDiscard}
          className="btn btn-ghost ml-auto px-3 py-1.5 text-xs text-slate-500 disabled:opacity-50"
        >
          {msg("board.ai.apply.discard")}
        </button>
      </div>
    </div>
  );
}

// The applied success state: a teal confirmation with the officials outcome, then
// the save-point banner whose Undo restores the before-ai checkpoint in one tap.
function AppliedState({
  outcome,
  onUndo,
  undoing,
  msg,
}: {
  outcome: ApplyOutcome | null;
  onUndo: () => void;
  undoing: boolean;
  msg: ReturnType<typeof useMsg>;
}) {
  const officialsNote: MessageKey =
    outcome?.officials === "applied"
      ? "board.ai.apply.officialsApplied"
      : outcome?.officials === "error"
        ? "board.ai.apply.officialsError"
        : "board.ai.apply.officialsSkipped";
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-teal-800">
          <span aria-hidden>✓</span>
          {msg("board.ai.applied")}
        </p>
        <p className="mt-0.5 text-xs text-teal-700">{msg(officialsNote)}</p>
      </div>
      {outcome?.checkpointId && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
          <span aria-hidden className="text-slate-400">⟲</span>
          <p className="min-w-0 flex-1 text-[11px] text-slate-600">{msg("board.ai.apply.savepoint")}</p>
          <button
            type="button"
            disabled={undoing}
            onClick={onUndo}
            className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs font-semibold text-violet-700 disabled:opacity-50"
          >
            {undoing ? msg("board.ai.apply.undoing") : msg("board.ai.apply.undo")}
          </button>
        </div>
      )}
    </div>
  );
}

// The rule-suggestions checklist (§7). One row per constraint field the architect
// inferred, checked by default; the ticked set overlays the current config on the
// schedule-settings PUT. Enum/count values ride in a mono chip.
function SuggestChecklist({
  plan,
  keys,
  ticked,
  onToggle,
  msg,
}: {
  plan: AiPlanResponse;
  keys: SuggestionKey[];
  ticked: Set<SuggestionKey>;
  onToggle: (k: SuggestionKey) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  const cs = plan.constraint_suggestions;
  if (!cs) return null;
  const valueOf = (k: SuggestionKey): string | null => {
    switch (k) {
      case "restMin":
        return msg("board.ai.suggest.mins", { n: cs.restMin ?? 0 });
      case "restByGroup":
        return String(Object.keys(cs.restByGroup ?? {}).length);
      case "startWindows":
        return String((cs.startWindows ?? []).length);
      case "fieldFairness":
        return cs.fieldFairness ?? null;
      case "parallelism":
        return cs.parallelism ?? null;
      case "crossPersonClash":
        return cs.crossPersonClash ?? null;
      case "noBackToBack":
        return null;
    }
  };
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
        {msg("board.ai.suggest.title")}
      </p>
      <p className="mt-0.5 text-[11px] text-violet-700/80">{msg("board.ai.suggest.hint")}</p>
      <ul className="mt-2 space-y-1.5">
        {keys.map((k) => {
          const value = valueOf(k);
          const on = ticked.has(k);
          const rowLabel = msg(`board.ai.suggest.${k}` as MessageKey);
          return (
            <li key={k} className="flex items-center gap-2 rounded-md border border-violet-100 bg-white px-2 py-1.5">
              <label className="inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={on}
                  onChange={() => onToggle(k)}
                  aria-label={rowLabel}
                />
                <span
                  aria-hidden
                  className="grid h-4 w-4 place-items-center rounded border border-violet-300 text-[10px] text-white transition peer-checked:border-violet-500 peer-checked:bg-violet-500 peer-focus-visible:ring-2 peer-focus-visible:ring-violet-300"
                >
                  ✓
                </span>
              </label>
              <span className="min-w-0 flex-1 text-xs text-slate-700">{rowLabel}</span>
              {value !== null && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-700">
                  {value}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ msg, k }: { msg: ReturnType<typeof useMsg>; k: Parameters<ReturnType<typeof useMsg>>[0] }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-xs text-slate-500">
      {msg(k)}
    </p>
  );
}

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

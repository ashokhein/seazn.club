// W6 (#401) — the z3 repair solver, as the AI runners see it.
//
// Both runners (single-division `runAiPlan`, joint `runCompetitionAiPlan`) hit a
// verifier pass and then, on blocking conflicts, spend an LLM repair round. This
// module is what they try FIRST: a decomposed constraint solve that costs no
// tokens, no credits and no SDK call, and that either fixes the board or says
// exactly why it could not.
//
// Three properties this module exists to guarantee, none of which belongs in a
// runner:
//
//   1. IT NEVER FAILS THE RUN. Every throw the solver can produce — a rejected
//      verification, a WASM fault, a bad config — is caught here and turned into
//      a fallback the caller reads as "use the LLM". A repair that cannot be
//      done is not an error; it is the status quo before this wave.
//   2. IT NEVER WAITS LONGER THAN ITS BUDGET. `repairDecomposed` serialises
//      per process (its `resetZ3()` tears down a shared WASM context), so a
//      second caller QUEUES — and the engine starts a call's budget clock when
//      its own work begins, not when it was made. A run parked behind another
//      run's solve would therefore sit past its own deadline with the engine
//      reporting a perfectly healthy elapsed time. Two guards: a non-blocking
//      in-process gate that declines rather than queues, and a wall-clock race
//      that bounds the wait even when the engine queue is held from elsewhere.
//   3. IT IS TELEMETRY-VISIBLE EITHER WAY. #401 requires the fallback to be
//      visible, not merely correct. Every path fills {@link SolverTelemetry},
//      including the paths where the solver never ran.
import {
  repairDecomposed,
  type Assignment,
  type DecomposedRepairResult,
  type DecomposedRepairStatus,
  type MinimalityVerdict,
  type OrderDependency,
  type RepairComponentReport,
  type VerifyConfig,
} from "@seazn/engine/scheduling";

/**
 * Wall-clock ceiling on ONE solver attempt, measured from the moment this
 * module is asked, not from the moment the engine starts working.
 *
 * NOT `DEFAULT_DECOMPOSED_BUDGET_MS` (240_000). That constant is documented in
 * the engine as a TERMINATION bound for batch use — "any caller on an HTTP path
 * must pass its own `budgetMs`" — and four minutes inside a web request is not a
 * budget, it is an outage.
 *
 * 45 s, from the measurements this wave recorded:
 *
 *   * The thing this replaces is an LLM repair round, bounded by
 *     `ROUND_TIMEOUT_MS` = 600_000 and costing tokens and credits. A solver
 *     ceiling has to be small beside one round or the fallback path — solver
 *     burns its budget, LLM round then runs anyway — makes the run slower than
 *     not having a solver at all. 45 s is 7.5% of one round's ceiling.
 *   * It has to be large enough to be worth trying. A component solve is capped
 *     at `DEFAULT_COMPONENT_BUDGET_MS` = 20_000 and measured components peak at
 *     39 fixtures on a 500-fixture board, so 45 s buys two full-ceiling
 *     components plus the WASM boot and resets between them — and far more than
 *     that when components are easy, which is the ordinary case (a board with
 *     one court clash solves in well under a second).
 *   * The anytime property does the rest. Exhausting this budget on a big board
 *     returns a PARTLY repaired board, which is strictly better than the nothing
 *     a single whole-board solve returns, and the residue goes to the LLM round
 *     that was going to run anyway.
 *
 * Override per deployment with `SCHEDULING_REPAIR_BUDGET_MS`. Read per call
 * rather than at module load so a deployment — or a test — can change it without
 * depending on import order.
 */
export function solverBudgetMs(): number {
  const raw = Number(process.env.SCHEDULING_REPAIR_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/**
 * How much longer than its budget an attempt may take before we stop waiting.
 *
 * The engine's budget covers its own work. It does NOT cover the prologue's WASM
 * boot on a cold process (~200-300 ms), the pre-check pass on a large board, or
 * any time spent queued behind another solver entry point. This grace covers the
 * first two; anything past it means we are parked, and the honest answer is to
 * stop waiting and let the LLM repair the board.
 */
const WALL_GRACE_MS = 10_000;

/**
 * The floor under a RE-attempt's remaining run budget.
 *
 * The runners try the solver before every repair round, sharing one run-level
 * budget. Below this there is not enough left to boot the WASM and encode even a
 * trivial board, so the attempt would spend its whole remainder proving nothing
 * and then fall back anyway. The FIRST attempt of a run is exempt: an operator
 * who configures a tiny budget gets the attempt, and the telemetry, they asked
 * for.
 */
export const SOLVER_MIN_BUDGET_MS = 2_000;

/** The kill switch. `SCHEDULING_REPAIR_SOLVER=off` sends every run down the LLM
 *  repair path exactly as it behaved before this wave — no deploy needed. It
 *  exists because the solver runs a WASM module that has been seen to abort a
 *  process rather than return (see the wave's progress ledger), and an operator
 *  facing that needs a lever, not a rollback. */
export function solverEnabled(): boolean {
  return (process.env.SCHEDULING_REPAIR_SOLVER ?? "on").toLowerCase() !== "off";
}

/** Which engine produced the board the caller is returning. `none` means no
 *  repair changed it — either it verified clean, or repair was attempted and
 *  nothing was adopted. */
export type RepairEngine = "none" | "z3" | "llm";

/** Why the caller is falling back to LLM repair. Every value is a fact about
 *  this call, never a guess. */
export type SolverFallback =
  /** The kill switch is off. */
  | "disabled"
  /** Another run holds the solver; we declined rather than queue behind it. */
  | "queue_wait"
  /** The wall clock ran out before an answer arrived. */
  | "budget"
  /** The solver answered, but left components it could not resolve. */
  | "partial"
  /** The solver answered and resolved nothing. */
  | "unrepaired"
  /** The solver threw. Includes a rejected internal verification. */
  | "error"
  /** The solver answered, but the caller's own verifier did not agree the board
   *  was better, so its moves were discarded. */
  | "not_adopted"
  /** Joint runs only: the divisions in this run share no court, so there is no
   *  placement the solver could offer that is legal for all of them. See
   *  `jointSolverConfig`. */
  | "court_split";

/** Everything one solver attempt observed. `engine` is stamped by the caller,
 *  which is the only party that knows whether an LLM round ran afterwards.
 *
 *  snake_case throughout, to match the `usage` object it ships beside. */
export interface SolverTelemetry {
  /** False on the clean path and on both no-attempt paths (`disabled`,
   *  `queue_wait`) — so "did we pay for z3 at all" is one field, not an
   *  inference over five. */
  solver_ran: boolean;
  status?: DecomposedRepairStatus;
  /** The minimal number of fixtures moved — `k`. */
  moved?: number;
  ms?: number;
  checks?: number;
  /** `upper_bound` means `k` is the fewest moves this decomposition found, not
   *  the fewest that exist. Never claim minimal when the engine did not. */
  minimality?: MinimalityVerdict;
  components_solved?: number;
  components_skipped?: number;
  /** Fixtures in components the solver did not resolve — the set handed to the
   *  LLM round. */
  unresolved?: number;
  /** Conflicts the board still carries after the solve, blocking or not. A
   *  `repaired` result with a non-empty `relaxed` leaves NON-blocking residue
   *  that `unresolved` deliberately excludes, so the two fields together are
   *  what "how clean is this really" reads. */
  residual?: number;
  /** Families some component dropped to find any answer at all. Non-empty means
   *  the board is legal but the solver gave something up to get there. */
  relaxed?: string[];
  /** Families named by a component that came back infeasible — "no schedule can
   *  satisfy all of these at once". */
  families?: string[];
  /** The budget ran out somewhere: a component timed out, or the wall fired. */
  timed_out?: boolean;
  fallback?: SolverFallback;
}

export interface SolveBoardInput {
  /** Fixtures the solver may move. PINNED fixtures must NOT be here — put them
   *  in `existing`, or the solver will happily move a locked slot. */
  proposal: readonly Assignment[];
  /** Immovable occupancy: obstacles, other stages, pinned fixtures. */
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  config: VerifyConfig & { courts: readonly string[] };
  budgetMs?: number;
}

export interface SolveBoardOutcome {
  /** The repaired board, when the solver produced one worth offering. `null`
   *  whenever the caller should not look at it — every no-attempt path, every
   *  throw, and the `unrepaired` status. The caller still has to verify it: this
   *  module never decides that a board is good enough. */
  assignments: readonly Assignment[] | null;
  /** The fixtures whose slot changed, sorted. Empty whenever `assignments` is
   *  null, and empty on a `clean` result — a board that already verified. */
  movedFixtureIds: readonly string[];
  /** Fixtures inside components the solver did not resolve. Sorted. */
  unresolvedFixtureIds: readonly string[];
  telemetry: SolverTelemetry;
}

/** {@link SolverTelemetry} once a caller has stamped which engine produced the
 *  board it is returning. This is the shape that reaches the API. */
export interface RepairReport extends SolverTelemetry {
  engine: RepairEngine;
}

/**
 * True while a solve is in flight anywhere in this process.
 *
 * A NON-BLOCKING gate, deliberately: the engine's own queue would make a second
 * caller wait, and a caller that waits has spent its budget on nothing. Two AI
 * runs land concurrently often enough (a joint run and a division run share this
 * process), and for the second one "the LLM repairs this board" is a far better
 * answer than "sit here for 45 s and then let the LLM repair this board".
 */
let solverBusy = false;

const noAttempt = (fallback: SolverFallback): SolveBoardOutcome => ({
  assignments: null,
  movedFixtureIds: [],
  unresolvedFixtureIds: [],
  telemetry: { solver_ran: false, fallback },
});

/**
 * One solver attempt. Never throws.
 *
 * The caller is expected to re-verify `assignments` with its OWN verifier before
 * adopting them — this module returns a candidate, not a verdict. That is not
 * belt-and-braces: the joint runner verifies per division with per-division
 * configs and hands the solver one merged config, so its own pass is the only
 * authority on whether the merged view was faithful.
 */
export async function solveBoard(input: SolveBoardInput): Promise<SolveBoardOutcome> {
  if (!solverEnabled()) return noAttempt("disabled");
  if (solverBusy) return noAttempt("queue_wait");

  const budgetMs = input.budgetMs ?? solverBudgetMs();
  const reports: RepairComponentReport[] = [];
  solverBusy = true;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = repairDecomposed({
      proposal: input.proposal,
      existing: input.existing,
      dependencies: input.dependencies,
      config: input.config,
      budgetMs,
      onComponent: (r) => reports.push(r),
    });
    // The wall. `repairDecomposed` cannot be cancelled, so the loser of this
    // race keeps running — it is caught (never an unhandled rejection) and its
    // answer is dropped. The busy flag is released in `finally` when the real
    // call settles, so an abandoned solve still blocks the next attempt rather
    // than being raced by it.
    const wall = new Promise<"wall">((resolve) => {
      timer = setTimeout(() => resolve("wall"), budgetMs + WALL_GRACE_MS);
    });
    const settled = await Promise.race([
      attempt.then((r) => ({ ok: true as const, r })),
      wall,
    ]);
    if (settled === "wall") {
      // Do not release the gate: the abandoned call still owns the WASM context.
      void attempt.then(
        () => undefined,
        () => undefined,
      );
      return {
        assignments: null,
        movedFixtureIds: [],
        unresolvedFixtureIds: [],
        telemetry: {
          solver_ran: true,
          ms: Date.now() - startedAt,
          components_solved: reports.filter((r) => r.outcome === "clean" || r.outcome === "repaired").length,
          components_skipped: reports.filter((r) => r.outcome !== "clean" && r.outcome !== "repaired").length,
          timed_out: true,
          fallback: "budget",
        },
      };
    }
    return summarise(settled.r, Date.now() - startedAt);
  } catch {
    // Every throw lands here, including `RepairVerificationError` — the engine's
    // "I produced a board my own verifier rejects" alarm. Loud in the engine's
    // tests, silent for the organiser: the LLM repairs the board exactly as it
    // did before this wave, and telemetry records that the solver blew up.
    return {
      assignments: null,
      movedFixtureIds: [],
      unresolvedFixtureIds: [],
      telemetry: { solver_ran: true, ms: Date.now() - startedAt, fallback: "error" },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    solverBusy = false;
  }
}

function summarise(result: DecomposedRepairResult, wallMs: number): SolveBoardOutcome {
  const solved = result.components.filter((c) => c.outcome === "clean" || c.outcome === "repaired");
  const skipped = result.components.filter((c) => c.outcome !== "clean" && c.outcome !== "repaired");
  const families = [
    ...new Set(result.components.flatMap((c) => [...(c.infeasibleFamilies ?? [])])),
  ].sort();
  const telemetry: SolverTelemetry = {
    solver_ran: true,
    status: result.status,
    moved: result.k,
    // The engine's own elapsed excludes any time this call spent queued; the
    // wall is what the request actually paid. Report the wall.
    ms: wallMs,
    checks: result.checks,
    minimality: result.minimality.verdict,
    components_solved: solved.length,
    components_skipped: skipped.length,
    unresolved: result.unresolvedFixtureIds.length,
    residual: result.residual.length,
    ...(result.relaxed.length > 0 ? { relaxed: [...result.relaxed] } : {}),
    ...(families.length > 0 ? { families } : {}),
    ...(skipped.some((c) => c.outcome === "timeout" || c.skipReason === "budget_exhausted")
      ? { timed_out: true }
      : {}),
    ...(result.status === "partial"
      ? { fallback: "partial" as const }
      : result.status === "unrepaired"
        ? { fallback: "unrepaired" as const }
        : {}),
  };
  return {
    // `unrepaired` moved nothing, so there is no board to offer. `partial` moved
    // something and IS offered: the anytime property is only worth having if a
    // partly repaired board reaches the caller.
    assignments: result.status === "unrepaired" ? null : result.assignments,
    movedFixtureIds: result.status === "unrepaired" ? [] : result.moved,
    unresolvedFixtureIds: result.unresolvedFixtureIds,
    telemetry,
  };
}

/**
 * Fold the solver's moves back into the model's plan.
 *
 * Only `scheduled_at` and `court_label` change, and only for fixtures the solver
 * actually moved: an assignment the solver left alone keeps the model's own
 * rendering byte for byte, so a diff between the two boards shows the repair and
 * nothing else.
 *
 * `renderIso` is injected rather than imported to keep this module free of a
 * cycle with the runners that own the zone-aware renderer.
 */
export function applySolverMoves<P extends { assignments: { fixture_id: string; scheduled_at: string; court_label: string }[] }>(
  plan: P,
  repaired: readonly Assignment[],
  movedIds: readonly string[],
  renderIso: (instantMs: number) => string,
): P {
  if (movedIds.length === 0) return plan;
  const moved = new Set(movedIds);
  const byId = new Map(repaired.map((a) => [a.fixtureId, a]));
  return {
    ...plan,
    assignments: plan.assignments.map((a) => {
      if (!moved.has(a.fixture_id)) return a;
      const to = byId.get(a.fixture_id);
      if (to === undefined) return a;
      return { ...a, scheduled_at: renderIso(to.startAt), court_label: to.court };
    }),
  };
}

/** Test seam: the busy gate is module state, and a suite that races two solves
 *  needs to prove the second one declines. Never called by production code. */
export function __setSolverBusyForTest(busy: boolean): void {
  solverBusy = busy;
}

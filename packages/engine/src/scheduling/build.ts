// The build solver's control loop.
//
// Greedy seeds the incumbent, so the answer is never worse than today's — that
// property is what lets this ship with NO escape hatch back to greedy (design
// D6). Tiers then improve the incumbent in a fixed lexicographic order, each by
// a bound walk under push/pop: assert the objective is strictly better than the
// incumbent, solve, and on SAT take the new board. The last satisfiable bound
// IS the optimum, by construction rather than by an objective function nobody
// can audit — the same reason `repair.ts` walks k upward instead of minimising
// a weighted sum.
//
// The budget is z3's `rlimit`, a DETERMINISTIC resource counter, not the wall
// clock (design D9). An anytime search cut off by wall clock returns a
// different board on a faster machine, which is both a support ticket and a
// permanently flaky test. The wall clock survives only as an outer cap that
// should never fire.
//
// --- the seed is LEGALISED before it is measured ---------------------------
//
// `slotFixtures` does not read `config.window`: its only bound is
// `horizonMinutes`, a 365-day default (`calendar.ts:390`). `repairUniverse`,
// which bounds the lattice this solver searches, DOES read it. So on any
// competition that overruns its own window greedy places every card — outside
// the window, reporting nothing — while z3 can only place the ones that fit
// inside it. D3 ranks `placed` first, so that illegal board outranks every
// legal one and would stay the incumbent forever, making the whole feature
// inert on exactly the boards it exists to fix.
//
// The fix is to make `placed` mean LEGALLY placed: every seed row carrying a
// BLOCKING conflict is dropped before the seed is measured. Those cards were
// already conflicts — counting them as placed was the bug — and the drop is
// provably sound, because every blocking reason is either per-row (`window`)
// or names both sides of a pair (`court`, `person_overlap`) or names the
// dependent (`order`), so removing every named row cannot leave one behind and
// cannot create a new one. The floor therefore becomes a LEGAL board, and
// "never worse than greedy" becomes a stronger claim rather than a weaker one.
//
// --- three verdicts, and why the third is the point -------------------------
//
// A `check()` here has THREE outcomes and they are not two:
//
//   sat      a board exists at this bound, and it is in hand;
//   unsat    a PROOF that no board reaches this bound;
//   unknown  no proof either way inside the budget.
//
// `unknown` is T0's EXPECTED terminal state near the optimum — finding a good
// board is fast, proving a tight ceiling is not — and it is not an error and
// not an infeasibility. Collapsing it onto `infeasible` would report an
// impossibility nobody established, which is precisely the defect this tier
// exists to remove: greedy's `no_slot` is a GUESS, and replacing one guess with
// a differently-dressed guess buys nothing. When the answer is `unknown` the
// incumbent simply stands and `budgetExpired` says why. Both sites that can
// see an `unknown` — the feasibility probe and the T0 walk — are pinned by
// their own test.
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { buildGrid, type BuildSlot } from "./build-grid.ts";
import { encodeBuild, type BuildConfig } from "./build-encode.ts";
import {
  deltaConflicts,
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import { repairUniverse } from "./repair-domain.ts";
import { loadZ3, withZ3Lock } from "./z3-load.ts";

/** Set by `scripts/bench-build.ts` (Task 15) — a placeholder until it runs. */
export const DEFAULT_BUILD_RLIMIT = 40_000_000;
/** The outer safety cap. Not the stopping rule; see the header. */
export const DEFAULT_BUILD_WALL_MS = 30_000;

export type BuildStatus =
  /** A board was produced and the gate accepted it. */
  | "ok"
  /** Every tier that ran completed, and none of them could improve on the
   *  greedy seed. A PROOF, not an opinion — the distinction from `ok` is
   *  exactly the distinction between "we stopped looking" and "there is
   *  nothing to find". */
  | "already_optimal"
  /** z3 PROVED no better board exists, and the proof is one of two:
   *
   *    * the bare feasibility probe came back unsat, which can only happen
   *      through a pin (see `solveBuild` §5);
   *    * the T0 walk proved `AtLeast(placed, 1)` unsat, i.e. not one card can
   *      be placed legally.
   *
   *  Never inferred from an `unknown`, and never from an unsat at a bound
   *  above 1 — that is `already_optimal`. The greedy board is still returned. */
  | "infeasible"
  /** The encoder and `validateAssignments` disagreed and the solver's board
   *  INTRODUCED a blocking conflict. The greedy seed is returned and the
   *  disagreement is logged. */
  | "verifier_rejected"
  /** The WASM would not boot. A fallback, never an exception. */
  | "z3_unavailable"
  /** Reserved for a caller that declines to queue behind `withZ3Lock` rather
   *  than wait for it (Task 6). `buildSchedule` itself always waits, so it
   *  never returns this. */
  | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  /**
   * `hard` and `restByDivision` are picked in explicitly because `SlotConfig`
   * has neither and `VerifyConfig` has both. Without them a caller writing
   * `{ ...packConfig, hard: compiled }` gets TS2353, deletes the field to make
   * it compile, and every compiled instruction rule silently stops binding —
   * `restByDivision` has no other channel at all, and a cross-division pair
   * then rests at whichever division's number happened to be asked.
   */
  config: SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision">;
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  /** POLISH only: fixture ids that may not move. Anchored to `locked` when the
   *  caller supplied one, and to greedy's placement otherwise — see
   *  `publishedSlotOf`. */
  frozen?: readonly string[];
  rlimit?: number;
  wallMs?: number;
  /** Not read here. BUILD and POLISH differ only in whether `frozen` is
   *  populated, and REFLOW is `repairSchedule`'s job by design; Task 5/6 owns
   *  any behaviour this needs to gate. */
  mode?: "build" | "polish";
}

export interface BuildResult {
  assignments: readonly Assignment[];
  /** Everything wrong with `assignments`, INCLUDING a row per fixture that is
   *  not on the board. `validateAssignments` cannot report an absence — it
   *  iterates the rows it is given — so without this a solver that placed
   *  nothing would hand back an empty conflict list and read as a clean board.
   *  Each absent fixture carries what ACTUALLY happened to it, never a
   *  fabricated one: greedy's own diagnosis if greedy could not place it, the
   *  blocking conflict that disqualified it if the seed was legalised, and only
   *  otherwise a `no_slot` whose detail says whether a proof backs it. */
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  /** Where the returned board came from, not which solver was consulted: `z3`
   *  means the board on this result is one z3 produced. */
  engine: "greedy" | "z3" | "z3+lns";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  moved: number;
}

/**
 * The verifier gate's decision, as a pure function.
 *
 * A DELTA, not an absolute test, and that is a behavioural ruling rather than a
 * convenience. Blocking conflicts predate this solver: `person_overlap` and
 * `window` became blocking in #399 over boards that were published while they
 * were warnings, and an absolute gate would refuse the solver's answer on every
 * one of those boards forever — the feature would be dead on exactly the dirty
 * boards `deltaConflicts` exists to keep editable. "Never worse than greedy" is
 * enforced by `isStrictlyBetter` on the metrics, not here.
 *
 * `before` is the RAW greedy board — what the organiser gets today — so a
 * breach that is already theirs is not laid at the solver's door.
 *
 * Blocking-filtered BEFORE the delta, deliberately: `conflictKey` is
 * `fixtureId|reason|detail` and does not include `direct`, so a warn-only
 * `order` row and a blocking one can share a key and would cancel.
 *
 * Scoped to `ours` because `validateAssignments` attributes an `order` conflict
 * between two `existing` rows to a fixture this solver never placed. Refusing
 * our own answer over one would be a lock-out with no fix, since nothing the
 * solver can do changes it. Under the delta rule this is belt-and-braces — an
 * unchanged sibling conflict is already matched away — which is why it is
 * exercised here rather than through `buildSchedule`.
 */
export function rejectedBlockingConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
  ours: ReadonlySet<string>,
): Conflict[] {
  return deltaConflicts(before.filter(isBlockingConflict), after.filter(isBlockingConflict)).filter(
    (c) => ours.has(c.fixtureId),
  );
}

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  // `withZ3Lock` is NOT reentrant. It is taken exactly here, and nothing below
  // may take it again — `loadZ3` deliberately does not, and neither does
  // anything in `build-encode.ts`.
  return withZ3Lock(() => solveBuild(input));
}

async function solveBuild(input: BuildInput): Promise<BuildResult> {
  // `performance.now()`, never `Date.now()` — `scripts/engine-boundary.ts` bans
  // ambient wall-clock reads in engine source, and a monotonic clock is the
  // right one for a duration anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  /**
   * ONE immovable board, read by three consumers that must not disagree.
   *
   * `encodeBuild` seeds its typed-rule day tallies from this array and
   * `validateAssignments` tallies from the array IT is handed; a filtered or
   * omitted copy on either side puts the encoder and the verifier on different
   * counts and reopens the placer/verifier fork. Every call below passes THIS
   * binding — never a filtered view, never `input.existing` re-defaulted — and
   * the two call sites are deliberately far apart, so this is the note that
   * connects them.
   */
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  const rlimit = input.rlimit ?? DEFAULT_BUILD_RLIMIT;
  const verifyConfig: BuildConfig = { ...config };

  // 1. The seed, and the legalisation pass that turns it into a floor worth
  //    having. See the header: `placed` has to mean LEGALLY placed or the
  //    solver can never beat greedy on a window-overrunning board.
  const rawSeed = slotFixtures({ fixtures, config, existing });
  const rawSeedConflicts = validateAssignments(
    rawSeed.assignments,
    verifyConfig,
    existing,
    dependencies,
  );
  /** Seed rows disqualified by a blocking conflict, mapped to the conflicts
   *  that disqualified them — so the result can report what ACTUALLY happened
   *  to the card instead of inventing a reason for it. */
  const disqualified = new Map<string, Conflict[]>();
  const seedIds = new Set(rawSeed.assignments.map((a) => a.fixtureId));
  for (const c of rawSeedConflicts) {
    if (!isBlockingConflict(c) || !seedIds.has(c.fixtureId)) continue;
    const rows = disqualified.get(c.fixtureId);
    if (rows === undefined) disqualified.set(c.fixtureId, [c]);
    else rows.push(c);
  }
  const seedAssignments = rawSeed.assignments.filter((a) => !disqualified.has(a.fixtureId));
  const seedMetrics = boardMetrics(seedAssignments, config.courts, fixtures.length);

  /**
   * A board's conflicts, in full.
   *
   * `validateAssignments` answers for the rows it is handed; the fixtures that
   * are NOT on the board are the other half of the truth and it cannot see
   * them. Three sources, in order of how well established they are, because a
   * fabricated reason is fed straight to the repair prompt:
   *
   *   1. greedy's own diagnosis, which names the binding constraint;
   *   2. the blocking conflict that disqualified the row from the seed;
   *   3. only then a `no_slot` — and `proved` decides whether its detail claims
   *      a ceiling (T0 came back unsat) or admits the budget ran out.
   */
  const conflictsFor = (board: readonly Assignment[], proved: boolean): Conflict[] => {
    const onBoard = new Set(board.map((a) => a.fixtureId));
    const out: Conflict[] = validateAssignments(board, verifyConfig, existing, dependencies);
    for (const f of fixtures) {
      if (onBoard.has(f.id)) continue;
      const greedySaid = rawSeed.conflicts.filter((c) => c.fixtureId === f.id);
      if (greedySaid.length > 0) {
        out.push(...greedySaid);
        continue;
      }
      const dropped = disqualified.get(f.id);
      if (dropped !== undefined) {
        out.push(...dropped);
        continue;
      }
      out.push({
        fixtureId: f.id,
        reason: "no_slot",
        detail: proved
          ? "no legal slot in the lattice"
          : "left unplaced when the solver's budget expired",
        rule: RULE_BY_REASON.no_slot,
      });
    }
    return out;
  };

  const greedy = (status: BuildStatus, budgetExpired = false): BuildResult => ({
    assignments: seedAssignments,
    conflicts: conflictsFor(seedAssignments, false),
    metrics: seedMetrics,
    engine: "greedy",
    status,
    tiersCompleted: 0,
    budgetExpired,
    elapsedMs: elapsed(),
    moved: 0,
  });

  // 2. The lattice.
  //
  //    A universe that ends before the fixtures begin is not a small lattice,
  //    it is the WRONG one: `repairUniverse` falls back to the first day of the
  //    unix epoch when there is no competition window, no session window and no
  //    existing board, and solving over that would "improve" the board onto
  //    slots in 1970. Refused for the same reason `buildGrid` refuses a
  //    truncated lattice over `MAX_SLOTS`: a lattice the encoder cannot tell
  //    apart from a legal one is worse than none at all.
  const universe = repairUniverse({ proposal: [], existing, config });
  if (config.startAt >= universe.to) return greedy("ok");

  /**
   * Where a card the caller says may not move actually IS.
   *
   * `locked` first, because that is the only placement in `BuildInput` the
   * CALLER supplied; greedy's own re-placement is a fallback and not the same
   * thing — freezing a card to a slot greedy just invented would pin POLISH to
   * a time the organiser never saw. `BuildInput` carries no published-board
   * field, so a POLISH caller that wants a true freeze must set `locked`
   * (flagged for Task 6).
   *
   * The RAW seed, not the legalised one: a card the legalisation pass dropped
   * still has a placement the organiser is looking at.
   */
  const publishedSlotOf = (id: string): BuildSlot | undefined => {
    const f = fixtures.find((x) => x.id === id);
    if (f?.locked !== undefined) return f.locked;
    const at = rawSeed.assignments.find((a) => a.fixtureId === id);
    return at === undefined ? undefined : { court: at.court, startAt: at.startAt };
  };

  const frozenIds = input.frozen ?? [];
  // Every anchor is PINNED into the lattice, exactly as a `locked` placement
  // is. This is the deliberate answer to an off-grid freeze — a card the
  // organiser dragged to 09:07, or one greedy parked against the edge of an
  // existing booking. Dropping it (what a bare `findIndex === -1` did) lets the
  // card move under POLISH while the result still says `ok`, which is the one
  // outcome that silently breaks the caller's contract; refusing the whole run
  // would contradict "auto-schedule always hands back a board". Pinning honours
  // the freeze, and any illegality the pin causes surfaces through the ordinary
  // conflict and gate path where somebody can see it.
  const pinned: BuildSlot[] = [
    ...fixtures.flatMap((f) => (f.locked !== undefined ? [f.locked] : [])),
    ...frozenIds.flatMap((id) => {
      const at = publishedSlotOf(id);
      return at === undefined ? [] : [at];
    }),
  ];
  const grid = buildGrid({ config, existing, pinned });
  if (grid.overCap || grid.slots.length === 0) return greedy("ok");

  // 3. z3. A boot failure is a fallback, never an exception: auto-schedule must
  //    always hand back a board.
  let Z3;
  try {
    ({ Z3 } = await loadZ3());
  } catch {
    return greedy("z3_unavailable");
  }

  const solver = new Z3.Solver();
  solver.set("rlimit", rlimit);
  /** The outer cap, refreshed before every check the way `repair.ts` does it —
   *  one `timeout` set once would give the last check the whole budget again. */
  const armTimeout = (): void => {
    solver.set("timeout", Math.max(1, Math.ceil(wallMs - elapsed())));
  };
  armTimeout();

  const model = encodeBuild({
    Z3,
    solver,
    fixtures,
    grid,
    config: verifyConfig,
    // The same binding `validateAssignments` is handed below. See its comment.
    existing,
    dependencies,
  });

  /** `AtLeast` takes a NON-EMPTY tuple, not varargs. `Z3.AtLeast(...lits, k)`
   *  compiles and then fails at runtime with a spread TypeError out of z3's own
   *  internals; `repair.ts:862` spells the same shape correctly. */
  const atLeastPlaced = (k: number): void => {
    const [head, ...rest] = model.placed;
    if (head === undefined) return;
    solver.add(Z3.AtLeast([head, ...rest], k));
  };

  // 4. POLISH freezes the cards an entrant has already been told about. Every
  //    anchor is in `pinned` above, so the lattice is guaranteed to contain it
  //    and `findIndex` cannot come back -1 for a card that has an anchor at all.
  for (const id of frozenIds) {
    const i = fixtures.findIndex((f) => f.id === id);
    const at = publishedSlotOf(id);
    // No anchor at all: greedy could not place it and the caller pinned
    // nothing, so there is no placement to hold it to. Left free rather than
    // pretended-frozen.
    if (i < 0 || at === undefined) continue;
    const s = grid.slots.findIndex((sl) => sl.court === at.court && sl.startAt === at.startAt);
    if (s >= 0) solver.add(model.place[i]![s]!);
  }

  let budgetExpired = false;

  // 5. The infeasibility probe — asked ONLY when something is pinned, and only
  //    while there is budget left to ask in.
  //
  //    Without a pin the model is satisfiable by inspection (the empty board):
  //    every clause `encodeBuild` writes is an at-most, a negation or an
  //    equivalence, and `placed[i]` is free to be false. So the probe could only
  //    ever answer "sat" and would cost a full check for it; at 200 fixtures a
  //    bare `check()` is ~10 s of a 30 s budget. With a pin it is the only way
  //    to tell "two cards pinned onto one slot" from "n cards will not fit",
  //    and those want opposite answers.
  if (pinned.length > 0) {
    if (elapsed() >= wallMs) {
      // Never asked, so nothing is established. Reporting `infeasible` from a
      // question we did not get to ask is the same error as reading it off an
      // `unknown`.
      budgetExpired = true;
    } else {
      armTimeout();
      const probe = await solver.check();
      if (probe === "unsat") return greedy("infeasible");
      // `unknown` is exhaustion, not a verdict — the ABSENCE of a proof. Fall
      // through and let the walk below report `budgetExpired` on the greedy
      // incumbent.
      if (probe === "unknown") budgetExpired = true;
    }
  }

  let incumbent: readonly Assignment[] = seedAssignments;
  let incumbentMetrics = seedMetrics;
  let tiersCompleted = 0;
  let checks = 0;
  let improved = false;

  // 6. T0 — maximise the number placed. This is what turns greedy's `no_slot`
  //    GUESS into a proof: UNSAT at `placed >= n` is the proof that n is out of
  //    reach, and SAT is a board that reaches it. Descending from the full
  //    count means the FIRST satisfiable bound is the optimum, by construction.
  for (let target = fixtures.length; target > incumbentMetrics.placed; target--) {
    if (budgetExpired || elapsed() >= wallMs) {
      budgetExpired = true;
      break;
    }
    solver.push();
    atLeastPlaced(target);
    armTimeout();
    checks++;
    const verdict = await solver.check();
    if (verdict === "sat") {
      const board = model.assignmentsFrom(model.slotOf(solver.model()));
      const metrics = boardMetrics(board, config.courts, fixtures.length);
      solver.pop();
      if (isStrictlyBetter(metrics, incumbentMetrics)) {
        incumbent = board;
        incumbentMetrics = metrics;
        improved = true;
      }
      // Freeze the achieved count as a hard bound for every later tier: a tier
      // that shortens the makespan must not buy it by dropping a card.
      atLeastPlaced(incumbentMetrics.placed);
      break;
    }
    solver.pop();
    if (verdict === "unknown") {
      budgetExpired = true;
      break;
    }
  }
  // The tier completed iff it ran to a verdict rather than to the budget: a SAT
  // at some bound, or UNSAT all the way down to the incumbent's own count.
  const proved = checks > 0 && !budgetExpired;
  if (proved) tiersCompleted = 1;

  // Tiers 1-3 land in Task 5; the incumbent contract above is what they extend.
  // Each of them is another descending-bound walk over `incumbent` /
  // `incumbentMetrics` / `improved` / `budgetExpired`, and each increments
  // `tiersCompleted` on the same "ran to a verdict" condition.

  // 7. The gate. Encoder and verifier disagreeing is the exact bug class this
  //    design exists to prevent, so it is never silent — but it is also never
  //    an exception, because the organiser still needs a board, and it is a
  //    DELTA rather than an absolute test (see `rejectedBlockingConflicts`).
  //
  //    `repair.ts` throws `RepairVerificationError` in the analogous place and
  //    this deliberately does not, so the loudness has to come from somewhere.
  const conflicts = conflictsFor(incumbent, proved);
  const ours = new Set(incumbent.map((a) => a.fixtureId));
  const rejected = rejectedBlockingConflicts(rawSeedConflicts, conflicts, ours);
  if (rejected.length > 0) {
    // The one place this library prints. The caller is handed a VALID board and
    // a status field they may never read, so an encoder/verifier fork would
    // otherwise reach nobody until an organiser filed a ticket about it.
    // eslint-disable-next-line no-console
    console.error(
      `buildSchedule: verifier rejected the solver's board (${rejected
        .map((c) => `${c.fixtureId}:${c.reason}`)
        .join(", ")}) — falling back to the greedy seed`,
    );
    return { ...greedy("verifier_rejected", budgetExpired), tiersCompleted };
  }

  const seedById = new Map(seedAssignments.map((a) => [a.fixtureId, a]));
  const moved = incumbent.filter((a) => {
    const was = seedById.get(a.fixtureId);
    return was === undefined || was.court !== a.court || was.startAt !== a.startAt;
  }).length;

  // `already_optimal` needs BOTH halves: a check that came back with a verdict,
  // and nothing to show for it. Without the first it would claim a proof on a
  // board nobody looked at; without the second it would fire on a board that
  // was just improved.
  let status: BuildStatus = "ok";
  if (proved && !improved) {
    status =
      incumbentMetrics.placed === 0 && fixtures.length > 0 ? "infeasible" : "already_optimal";
  }

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    engine: incumbent === seedAssignments ? "greedy" : "z3",
    status,
    tiersCompleted,
    budgetExpired,
    elapsedMs: elapsed(),
    moved,
  };
}

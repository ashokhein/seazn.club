// The large-neighbourhood fallback (design D7's "C" half).
//
// When the whole-board model does not converge — a board whose lattice the
// monolithic solve cannot chew through inside its budget, or a tier walk that
// ran out before it proved anything — this spends what is left on WINDOWS
// instead: freeze all but a slice of the board, re-solve that slice with
// everything else immovable, and keep the answer only if the WHOLE board got
// lexicographically better.
//
// --- what a window is re-solved WITH, and why it is not `repairSchedule` -----
//
// The plan sketched this over `repairSchedule`, on the reading that a window is
// a small board and `repair.ts` already solves small boards. It does not solve
// the RIGHT problem. `repairSchedule` minimises the NUMBER OF MOVES needed to
// make a board legal and has no objective beyond that; its first act is a
// verifier precheck that returns `status: "clean"` with zero z3 checks when the
// proposal already validates (`repair.ts:266-278`). Every board this fallback
// is ever handed is already legal — `build.ts` legalises the greedy seed before
// it measures it, and every board a tier accepts has passed the verifier gate —
// so a repair-backed LNS returns its input unchanged, always. Measured on the
// obvious corner: three back-to-back cards on one court with a second court
// standing empty comes back `clean`/`checks: 0`, makespan 90 in and 90 out,
// while the lattice admits 60.
//
// So a window is re-solved by the BUILD solver — the same greedy seed, the same
// `encodeBuild` model, the same four lexicographic tiers — and it is handed the
// WHOLE board: the window's fixtures free, and every other row as a fixture
// `locked` to exactly where it already sits.
//
// THE ROWS OUTSIDE THE WINDOW CANNOT BE PASSED AS `existing`, and this is the
// second false premise in the plan. An `existing` row constrains the model (its
// court time leaves the lattice, its participants still clash) but it is
// INVISIBLE TO THE OBJECTIVE: `boardMetrics` is computed over the rows the
// solve placed, so a window solved in isolation optimises its own slice. Two of
// the three metrics are then measuring the wrong thing, and the makespan is
// worse than wrong — it is translation-invariant, so every start is equally
// good. Measured, and this is exactly what came back: freeze `a` at 09:00 and
// ask for `b` and `c` in a window with `a` as `existing`, and the answer is
// `b@C2+180, c@C1+180` — window makespan 30, a perfect local answer, and a
// board that grew from 90 minutes to 210. `improveByWindows` would reject it
// and the pass would be inert for the same reason the repair version is.
//
// Locking the rest of the board turns the sub-solve's own metrics INTO the
// global metrics, so its tiers optimise the thing that is actually being
// improved. It costs a full-size encode per window — the model is |board|
// fixtures wide either way — and buys the only thing that ever mattered: the
// SEARCH space is the window, because every other placement literal is a unit
// clause z3 propagates at level 0. That is the right trade here, because the
// encode was never the bottleneck: 1.4 s at 200 fixtures against a `check()`
// that returns `unknown` at 20 s.
//
// The solve itself is INJECTED (`solveWindow`) rather than imported, for two
// reasons that both matter: `build.ts` is the only place that knows the config,
// the dependency list, the rlimit and how much of the wall backstop is left,
// and importing `buildSchedule` here would make the module graph circular. It
// also means every decision this file makes — which windows, in what order,
// which answers are kept — is unit-testable without booting the WASM.
//
// --- the window size ---------------------------------------------------------
//
// `LNS_WINDOW_LIMIT` is `COMPONENT_MOVABLE_LIMIT`'s 50, reused deliberately
// rather than picked afresh, so the two solvers' scaling stories stay one
// story: 50 movable is the size `bench-repair.ts` measured as still tractable
// at the dense end.
//
// --- determinism -------------------------------------------------------------
//
// Two runs on identical input must produce identical output on any machine, so
// nothing here reads a clock of its own. The window PLAN is computed once, from
// the board as it arrived, before any window is solved — so which windows run
// does not depend on which earlier windows were accepted — and every ordering
// inside it breaks ties on `fixtureId`. `deadlineMs`/`elapsed` are the caller's
// existing outer liveness backstop (`build.ts`'s `wallMs`), passed in rather
// than read here, and they are a cap that should never fire; the real budget is
// the z3 `rlimit` the injected solve carries (design D9).
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import type { Assignment, SchedulableFixture } from "./calendar.ts";

/** The measured `COMPONENT_MOVABLE_LIMIT`, reused deliberately. */
export const LNS_WINDOW_LIMIT = 50;

/** One neighbourhood, as the injected solve sees it. */
export interface LnsWindow {
  /** EVERY fixture the sub-solve should see, in the caller's fixture order:
   *  the window's own, free, and every out-of-window row carrying a `locked`
   *  pin at exactly where it sits. See the header for why the pinned ones are
   *  here rather than in `existing` — it is what makes the sub-solve's metrics
   *  the GLOBAL metrics. A fixture that is neither in the window nor on the
   *  board is omitted: there is nothing to pin it to, and leaving it free would
   *  grow the neighbourhood past its cap. */
  fixtures: readonly SchedulableFixture[];
  /** The caller's own immovable board, unchanged. Rows that belong to no
   *  fixture of this run and therefore have no placement to optimise. */
  existing: readonly Assignment[];
  /** The ids that may move. Derivable from `fixtures` (they are the unpinned
   *  ones), and named anyway so telemetry and tests do not have to re-derive
   *  the pass's own decision. */
  movable: ReadonlySet<string>;
  /** This window's place in the plan, zero-based, and how many windows the plan
   *  holds. Present so a caller apportioning a run budget can divide what is
   *  left by the windows still to come (`of - index`) — the plan is
   *  materialised before the first solve precisely so that number exists, and
   *  it does not change as windows are accepted or refused. */
  index: number;
  of: number;
}

export interface LnsInput {
  /** The incumbent board. Rows for `fixtures` only; anything immovable belongs
   *  in `existing`. */
  board: readonly Assignment[];
  /** Every fixture the run owns, placed or not. The ORDER is the canonical row
   *  order an accepted board is returned in. */
  fixtures: readonly SchedulableFixture[];
  /** The immovable board the caller was given. Never windowed. */
  existing?: readonly Assignment[];
  /** Fixture ids that may not move (POLISH). Excluded from every window AND
   *  handed to the window solve as `existing`, so they are immovable on both
   *  sides of the seam rather than merely un-chosen. */
  frozen?: ReadonlySet<string>;
  /** The configured courts, for `boardMetrics`. The window solve applies R3
   *  itself; nothing here reintroduces a court. */
  courts: readonly string[];
  total: number;
  /** The caller's outer wall-clock backstop, in ITS elapsed-ms frame. Not the
   *  budget — see the header. */
  deadlineMs: number;
  elapsed: () => number;
  /** Checked before each window. False stops the pass and leaves the incumbent
   *  standing — the caller's run budget is spent. A NORMAL outcome, not an
   *  error, and deliberately a predicate rather than a number: the budget's
   *  unit is the caller's business, and nothing here should be able to spend
   *  it by accident. Absent means "no budget to answer for". */
  hasBudget?: () => boolean;
  solveWindow: (window: LnsWindow) => Promise<readonly Assignment[]>;
}

export interface LnsOutput {
  board: readonly Assignment[];
  metrics: BoardMetrics;
  /** Windows actually SOLVED — duplicates and the post-deadline tail are not
   *  counted, because the number exists to say what the budget bought. */
  windows: number;
}

/**
 * Re-solves the board a window at a time, keeping strict improvements only.
 *
 * "Strictly better" is `isStrictlyBetter` over `boardMetrics` of the WHOLE
 * candidate board — never the window's own metrics, and never a number computed
 * here. A window that shortens its own slice while lengthening the board is a
 * regression the organiser would see, and a metric re-derived locally is the
 * placer/verifier fork this subsystem keeps producing. Both are the same
 * mistake wearing different clothes, and one comparison rules out both.
 *
 * A window that merely RESHUFFLES is discarded for the same reason `repair.ts`
 * protects minimal movement: telling entrants a new time buys nothing unless
 * the board got better.
 */
export async function improveByWindows(input: LnsInput): Promise<LnsOutput> {
  const base = input.existing ?? [];
  const frozen = input.frozen ?? new Set<string>();
  const rank = new Map(input.fixtures.map((f, i) => [f.id, i]));

  let board = input.board;
  let metrics = boardMetrics(board, input.courts, input.total);
  let windows = 0;

  /**
   * THE PLAN, MATERIALISED BEFORE THE FIRST SOLVE.
   *
   * Two reasons, and the second is the load-bearing one. A board that fits on
   * one court makes the per-court window and the tail window the same
   * question, and asking z3 the same question twice is a second full-size
   * solve for a guaranteed non-improvement — so duplicates are dropped here
   * rather than mid-flight. And a caller apportioning a run budget needs to
   * know how many windows are still to come; that number cannot exist while
   * the plan is still being generated.
   */
  const seen = new Set<string>();
  const plan: ReadonlySet<string>[] = [];
  for (const ids of windowsOf(input.fixtures, input.board, frozen)) {
    const key = [...ids].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    if (input.fixtures.some((f) => ids.has(f.id))) plan.push(ids);
  }

  for (const [index, ids] of plan.entries()) {
    if (input.elapsed() >= input.deadlineMs) break;
    // The run budget is spent. Stop launching windows and let the incumbent
    // stand — not an error, and not a status: the caller asked for the best
    // board a budget could buy and this is it.
    if (input.hasBudget !== undefined && !input.hasBudget()) break;

    // Pins are read off the CURRENT board, not the one the plan was drawn
    // from: an earlier window may already have moved these rows.
    const rowOf = new Map(board.map((a) => [a.fixtureId, a]));
    const windowFixtures = input.fixtures.flatMap((f) => {
      if (ids.has(f.id)) return [f];
      const row = rowOf.get(f.id);
      return row === undefined ? [] : [{ ...f, locked: { court: row.court, startAt: row.startAt } }];
    });

    const placed = await input.solveWindow({
      fixtures: windowFixtures,
      existing: base,
      movable: ids,
      index,
      of: plan.length,
    });
    windows++;

    const candidate = [...placed].sort(
      (a, b) => (rank.get(a.fixtureId) ?? Infinity) - (rank.get(b.fixtureId) ?? Infinity),
    );
    const candidateMetrics = boardMetrics(candidate, input.courts, input.total);
    if (!isStrictlyBetter(candidateMetrics, metrics)) continue;
    board = candidate;
    metrics = candidateMetrics;
  }

  return { board, metrics, windows };
}

/**
 * The window plan, as fixture-id sets, in the order most likely to pay.
 *
 * Each court's own cards first — that is where imbalance and same-court slack
 * live — then the tail of the board, which is where makespan lives.
 *
 * EVERY window also carries the fixtures the board did not place. `placed` is
 * the top of D3's ordering, so a window that cannot raise it cannot improve the
 * board's rank at all except in the tiers below it; and an unplaced fixture has
 * no court and no start, so it belongs to no court window and would otherwise
 * be unreachable to this pass for the rest of the run. They go FIRST inside the
 * cap for the same reason.
 *
 * Ties break on `fixtureId` everywhere, so the plan is a function of the input
 * and not of `Array.prototype.sort`'s stability.
 */
function* windowsOf(
  fixtures: readonly SchedulableFixture[],
  board: readonly Assignment[],
  frozen: ReadonlySet<string>,
): Generator<ReadonlySet<string>> {
  const onBoard = new Set(board.map((a) => a.fixtureId));
  const unplaced = fixtures
    .filter((f) => !onBoard.has(f.id) && !frozen.has(f.id))
    .map((f) => f.id);

  const movable = board.filter((a) => !frozen.has(a.fixtureId));
  const byCourt = new Map<string, Assignment[]>();
  for (const a of movable) {
    const rows = byCourt.get(a.court);
    if (rows === undefined) byCourt.set(a.court, [a]);
    else rows.push(a);
  }

  const byStart = (x: Assignment, y: Assignment): number =>
    x.startAt - y.startAt || (x.fixtureId < y.fixtureId ? -1 : x.fixtureId > y.fixtureId ? 1 : 0);
  const take = (rows: readonly Assignment[]): ReadonlySet<string> =>
    new Set([...unplaced, ...rows.map((a) => a.fixtureId)].slice(0, LNS_WINDOW_LIMIT));

  for (const court of [...byCourt.keys()].sort()) {
    yield take([...byCourt.get(court)!].sort(byStart));
  }
  if (movable.length > 0) yield take([...movable].sort((a, b) => byStart(b, a)));
  // Nothing on the board to window around, but fixtures still waiting for a
  // slot. Without this the one case where LNS has the most to offer — a run
  // whose budget died before it placed anything — gets no window at all.
  else if (unplaced.length > 0) yield take([]);
}

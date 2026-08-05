// The large-neighbourhood fallback.
//
// Two layers, deliberately. The window PLAN and the acceptance rule are pure
// decisions and are tested against an INJECTED `solveWindow` — that is the only
// way to assert what the window solve was actually ASKED (a frozen card pinned
// rather than merely un-chosen, the rest of the board pinned rather than passed
// as `existing`, an unplaced fixture offered a slot), none of which is visible
// from the returned board. A stub that never moves anything passes every
// output-only assertion, which is why the plan's own sketches are not used.
//
// The last two cases then run the REAL build solver as `solveWindow`, because a
// plan that is never handed to z3 proves nothing about the feature.
//
// TWO MEASURED FACTS the plan was written against, recorded so nobody
// re-derives them:
//
//   * `repairSchedule` cannot drive this. It minimises MOVES to reach legality
//     and short-circuits on a legal board before it loads the WASM
//     (`repair.ts:266-278`), and every board this pass is handed is already
//     legal. The three-card corner below comes back `status: "clean"`,
//     `checks: 0`, makespan 90 in and 90 out.
//   * the out-of-window rows cannot be passed as `existing`. Measured: freeze
//     `a` at 09:00, hand `b` and `c` to a window with `a` as `existing`, and
//     the sub-solve answers `b@C2+180, c@C1+180` — window makespan 30, board
//     makespan 210 against the 90 it started at. `existing` constrains the
//     model and is invisible to the objective.
import { afterAll, describe, expect, it } from "vitest";
import { improveByWindows, LNS_WINDOW_LIMIT, type LnsWindow } from "./build-lns.ts";
import { buildSchedule } from "./build.ts";
import { boardMetrics } from "./build-objectives.ts";
import { resetZ3 } from "./z3-load.ts";
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const cfg = (over: Partial<SlotConfig> & { courts?: string[] } = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 240 * MIN },
  ...over,
});

const fx = (id: string): SchedulableFixture => ({ id, home: `${id}H`, away: `${id}A`, roundNo: 1 });

const card = (id: string, court: string, startMin: number): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + 30) * MIN,
  entrants: [`${id}H`, `${id}A`],
  people: [],
});

/** A recording `solveWindow`. The default reply is an empty board, which is
 *  always refused (`placed` drops), so a case that only cares about the REQUEST
 *  cannot accidentally accept one. */
const spy = (
  reply: (w: LnsWindow) => readonly Assignment[] = () => [],
): { calls: LnsWindow[]; solveWindow: (w: LnsWindow) => Promise<readonly Assignment[]> } => {
  const calls: LnsWindow[] = [];
  return {
    calls,
    solveWindow: (w) => {
      calls.push(w);
      return Promise.resolve(reply(w));
    },
  };
};

const ids = (rows: readonly { fixtureId: string }[]): string[] => rows.map((r) => r.fixtureId);
/** What the sub-solve may move, as the sub-solve itself would read it: the
 *  fixtures with no pin. Deliberately NOT `w.movable`, so a window that
 *  announced one set and pinned another is caught. */
const free = (w: LnsWindow): string[] =>
  w.fixtures.filter((f) => f.locked === undefined).map((f) => f.id);
const pinned = (w: LnsWindow): string[] =>
  w.fixtures
    .filter((f) => f.locked !== undefined)
    .map((f) => `${f.id}@${f.locked!.court}+${(f.locked!.startAt - T0) / MIN}`);

describe("improveByWindows — the window plan and the acceptance rule", () => {
  it("refuses a window that shortens the board by dropping a card", async () => {
    // D3 is LEXICOGRAPHIC with `placed` on top, so this is not a worse board in
    // any single metric: the candidate is strictly SHORTER (30 against 90) and
    // still has to lose. An acceptance rule that compared makespan — the
    // obvious wrong rule, and the one each tier walk itself compares — takes it.
    const fixtures = [fx("a"), fx("b")];
    const board = [card("a", "C1", 0), card("b", "C1", 60)];
    const shorter = [card("a", "C1", 0)];
    expect(boardMetrics(shorter, ["C1", "C2"], 2).makespanMinutes).toBe(30);
    const s = spy(() => shorter);
    const out = await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 2,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect({ rows: ids(out.board), makespan: out.metrics.makespanMinutes }).toEqual({
      rows: ["a", "b"],
      makespan: 90,
    });
  });

  it("refuses a window answer that is better locally and worse for the board", async () => {
    // The measured shape, verbatim: a window solve is free to translate its own
    // slice anywhere, and a board 120 minutes later is a perfectly good local
    // answer. The whole-board comparison is the only thing standing between the
    // organiser and it.
    const fixtures = [fx("a"), fx("b"), fx("c")];
    const board = [card("a", "C1", 0), card("b", "C1", 30), card("c", "C1", 60)];
    const local = [card("a", "C1", 0), card("b", "C2", 180), card("c", "C1", 180)];
    expect(boardMetrics(local.slice(1), ["C1", "C2"], 3).makespanMinutes).toBe(30);
    const s = spy(() => local);
    const out = await improveByWindows({
      board,
      fixtures,
      frozen: new Set(["a"]),
      courts: ["C1", "C2"],
      total: 3,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect(out.metrics.makespanMinutes).toBe(90);
    expect(out.board).toEqual(board);
  });

  it("pins every out-of-window row and passes only the caller's board as existing", async () => {
    // The correctness condition. A row handed in as `existing` constrains the
    // model but is invisible to `boardMetrics`, so the sub-solve would optimise
    // its own slice; a row handed in as a `locked` fixture is immovable AND
    // counted.
    const fixtures = [fx("a"), fx("b")];
    const board = [card("a", "C1", 0), card("b", "C2", 0)];
    const obstacle = card("x", "C1", 150);
    const s = spy();
    await improveByWindows({
      board,
      fixtures,
      existing: [obstacle],
      courts: ["C1", "C2"],
      total: 2,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect(
      s.calls.map((w) => ({
        free: free(w),
        pinned: pinned(w),
        existing: ids(w.existing),
        movable: [...w.movable].sort(),
      })),
    ).toEqual([
      { free: ["a"], pinned: ["b@C2+0"], existing: ["x"], movable: ["a"] },
      { free: ["b"], pinned: ["a@C1+0"], existing: ["x"], movable: ["b"] },
      { free: ["a", "b"], pinned: [], existing: ["x"], movable: ["a", "b"] },
    ]);
  });

  it("keeps a frozen card out of every window and pins it in each one", async () => {
    const fixtures = [fx("a"), fx("b")];
    const board = [card("a", "C1", 0), card("b", "C1", 120)];
    const s = spy();
    const out = await improveByWindows({
      board,
      fixtures,
      frozen: new Set(["b"]),
      courts: ["C1", "C2"],
      total: 2,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect(s.calls.map((w) => ({ free: free(w), pinned: pinned(w) }))).toEqual([
      { free: ["a"], pinned: ["b@C1+120"] },
    ]);
    expect(out.board.find((x) => x.fixtureId === "b")).toEqual(card("b", "C1", 120));
  });

  it("offers every window the fixtures the board never placed", async () => {
    // `placed` is the top of D3's ordering and an unplaced fixture has no court
    // to belong to, so without this it is unreachable to the pass for the whole
    // of the rest of the run.
    const fixtures = [fx("a"), fx("b"), fx("c")];
    const board = [card("a", "C1", 0), card("b", "C2", 0)];
    const s = spy((w) =>
      free(w).join(",") === "a,c"
        ? [card("a", "C1", 0), card("b", "C2", 0), card("c", "C1", 30)]
        : [],
    );
    const out = await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 3,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect({ free: free(s.calls[0]!), pinned: pinned(s.calls[0]!) }).toEqual({
      free: ["a", "c"],
      pinned: ["b@C2+0"],
    });
    expect({ rows: ids(out.board), placed: out.metrics.placed }).toEqual({
      rows: ["a", "b", "c"],
      placed: 3,
    });
  });

  it("asks the same window only once", async () => {
    // A board that fits on one court makes the per-court window and the tail
    // window the same question. Asking twice is a second full-size z3 solve for
    // a guaranteed non-improvement.
    const fixtures = [fx("a"), fx("b")];
    const board = [card("a", "C1", 0), card("b", "C1", 30)];
    const s = spy();
    const out = await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 2,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect({ windows: out.windows, calls: s.calls.map(free) }).toEqual({
      windows: 1,
      calls: [["a", "b"]],
    });
  });

  it("caps a window at the measured component limit", async () => {
    const fixtures = Array.from({ length: 60 }, (_, i) => fx(`f${String(i).padStart(2, "0")}`));
    const board = fixtures.map((f, i) => card(f.id, "C1", i * 30));
    const s = spy();
    await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 60,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect(LNS_WINDOW_LIMIT).toBe(50);
    // The court window takes the EARLIEST 50 and the tail window the LATEST 50
    // — a cap that sliced the same end twice would make the second window a
    // duplicate, and the dedupe above would then swallow it silently.
    expect(
      s.calls.map((w) => {
        const f = free(w);
        return { n: f.length, first: f[0], last: f.at(-1), pinned: w.fixtures.length - f.length };
      }),
    ).toEqual([
      { n: 50, first: "f00", last: "f49", pinned: 10 },
      { n: 50, first: "f10", last: "f59", pinned: 10 },
    ]);
  });

  it("returns an accepted board in fixture order, whichever window won", async () => {
    const fixtures = [fx("c"), fx("b"), fx("a")];
    const board = [card("a", "C1", 0), card("b", "C2", 0), card("c", "C2", 60)];
    const better = [card("c", "C2", 30), card("b", "C2", 0), card("a", "C1", 0)];
    const s = spy((w) => (free(w).join(",") === "c,b" ? better : []));
    const out = await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 3,
      deadlineMs: 20_000,
      elapsed: () => 0,
      solveWindow: s.solveWindow,
    });
    expect({ rows: ids(out.board), makespan: out.metrics.makespanMinutes }).toEqual({
      rows: ["c", "b", "a"],
      makespan: 60,
    });
  });

  it("stops before the first solve when the caller's backstop has already fired", async () => {
    const fixtures = [fx("a")];
    const board = [card("a", "C1", 0)];
    const s = spy(() => [card("a", "C2", 0)]);
    const out = await improveByWindows({
      board,
      fixtures,
      courts: ["C1", "C2"],
      total: 1,
      deadlineMs: 1_000,
      elapsed: () => 9_999,
      solveWindow: s.solveWindow,
    });
    expect({ windows: out.windows, calls: s.calls.length }).toEqual({ windows: 0, calls: 0 });
    expect(out.board).toBe(board);
  });
});

describe("improveByWindows — against the real build solver", () => {
  afterAll(async () => {
    await resetZ3();
  });

  const realSolve =
    (config: Cfg) =>
    async (w: LnsWindow): Promise<readonly Assignment[]> =>
      (await buildSchedule({ fixtures: w.fixtures, config, existing: w.existing })).assignments;

  it("compacts a board strung out on one court while another stood empty", async () => {
    const config = cfg();
    const fixtures = [fx("a"), fx("b"), fx("c")];
    const board = [card("a", "C1", 0), card("b", "C1", 30), card("c", "C1", 60)];
    expect(boardMetrics(board, config.courts, 3).makespanMinutes).toBe(90);
    const out = await improveByWindows({
      board,
      fixtures,
      courts: config.courts,
      total: 3,
      deadlineMs: 60_000,
      elapsed: () => 0,
      solveWindow: realSolve(config),
    });
    expect({ makespan: out.metrics.makespanMinutes, placed: out.metrics.placed }).toEqual({
      makespan: 60,
      placed: 3,
    });
  }, 120_000);

  it("compacts around a frozen card without moving it", async () => {
    // THE regression test for the `existing` shape. With `a` handed to the
    // sub-solve as `existing` this measured `b@C2+180, c@C1+180` — locally
    // optimal, board makespan 210, refused, board unchanged at 90. Pinning `a`
    // as a fixture instead makes the sub-solve's own makespan the board's, and
    // the answer is the 60 the lattice always admitted.
    const config = cfg();
    const fixtures = [fx("a"), fx("b"), fx("c")];
    const board = [card("a", "C1", 0), card("b", "C1", 30), card("c", "C1", 60)];
    const out = await improveByWindows({
      board,
      fixtures,
      frozen: new Set(["a"]),
      courts: config.courts,
      total: 3,
      deadlineMs: 60_000,
      elapsed: () => 0,
      solveWindow: realSolve(config),
    });
    expect(out.board.find((x) => x.fixtureId === "a")).toEqual(card("a", "C1", 0));
    expect({ makespan: out.metrics.makespanMinutes, placed: out.metrics.placed }).toEqual({
      makespan: 60,
      placed: 3,
    });
  }, 120_000);
});

// The z3 repair encoder works in MINUTES; `validateAssignments` works in
// MILLISECONDS. Every conversion between the two is therefore a place the two
// can disagree, and a disagreement in the WRONG direction is a board the solver
// proves clean and the verifier rejects — `RepairVerificationError` with
// `kind: "encoding_drift"` when it is loud, and a published clash when it is not.
//
// The rule the whole file exists to pin: **a rounded interval must be a
// SUPERSET of the real one.** Occupancy rounds outward (start down, end up),
// and a value used as a bound rounds to the side that makes the constraint
// STRONGER, never to "nearest".
//
// Sub-minute instants are reachable from the product, not a thought experiment:
// `AddFixture.scheduled_at` is a client-supplied RFC-3339 string with no
// seconds restriction, the single-move PATCH writes it verbatim, the column is
// `timestamptz`, and the AI usecase feeds `new Date(...).getTime()` straight
// into `Assignment.startAt`. Nothing between the wire and this encoder
// truncates to the minute.
//
// Every case below is minute-aligned APART FROM the one value under test, so a
// failure names its own call site.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  validateAssignments,
  type Assignment,
  type OrderDependency,
  type VerifyConfig,
} from "./calendar.ts";
import { repairAndVerify } from "./repair.ts";
import { at, BASE_CONFIG, STEP_RULE_FIXTURES } from "./payload-fixtures.ts";
import { syntheticBoard } from "./repair-synthetic-board.ts";
import { dayKeyInTz } from "./tz.ts";
import { resetZ3 } from "./z3-load.ts";

// Same teardown discipline as `repair.test.ts`: `isolate: false` means every
// test here shares one WASM heap, which only grows across solves until the
// pthread worker dies mid-solve.
afterAll(async () => {
  await resetZ3();
});
afterEach(async () => {
  await resetZ3();
});

const MIN = 60_000;
const SEC = 1_000;
const SOLVE_TIMEOUT = 120_000;

const t = (iso: string): number => at(iso);

/** A card with an explicit millisecond duration — `assign` only takes whole
 *  minutes, and a sub-minute duration is one of the things under test. */
const card = (
  fixtureId: string,
  startAt: number,
  durationMs: number,
  court: string,
  entrant: string,
): Assignment => ({
  fixtureId,
  court,
  startAt,
  endAt: startAt + durationMs,
  entrants: [entrant],
  // Deliberately EMPTY: `sharesParticipant` must stay false so the `court` and
  // `order` families are the only things binding, and a failure cannot be a
  // person clash wearing a court clash's clothes.
  people: [],
});

const config = (courts: readonly string[]): VerifyConfig & { courts: readonly string[] } => ({
  ...BASE_CONFIG,
  tz: "UTC",
  courts,
  window: { from: t("2026-08-10T08:00:00Z"), to: t("2026-08-10T20:00:00Z") },
});

/**
 * Asserts the board is REALLY dirty in milliseconds, then that repair both
 * survives its own verifier and actually moves the card.
 *
 * `repairAndVerify` rather than `repairSchedule`: when the encoder is too
 * permissive the solver answers k=0 with nothing relaxed, and that exact shape
 * is what `encoding_drift` is thrown for. A bare `repairSchedule` would hand
 * back `status: "repaired", moved: []` and only an assertion would notice.
 */
async function expectMovedAndClean(input: {
  proposal: Assignment[];
  existing?: Assignment[];
  dependencies?: OrderDependency[];
  config: VerifyConfig & { courts: readonly string[] };
  movedId: string;
}): Promise<void> {
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  expect(validateAssignments(input.proposal, input.config, existing, dependencies)).not.toEqual([]);

  const r = await repairAndVerify({
    proposal: input.proposal,
    existing,
    dependencies,
    config: input.config,
    budgetMs: 60_000,
  });
  expect(r.status).toBe("repaired");
  if (r.status !== "repaired") return;
  expect(r.relaxed).toEqual([]);
  expect(r.moved).toEqual([input.movedId]);
  expect(validateAssignments(r.assignments, input.config, existing, dependencies)).toEqual([]);
}

describe("repair encodes sub-minute instants conservatively", () => {
  it(
    "widens an immovable that ENDS mid-minute — a rounded-down end hands its last seconds away",
    async () => {
      // Obstacle ends 10:00:20. `roundMin` said 10:00, so `start >= eEnd`
      // admitted the movable's own 10:00:00 and NOTHING moved. `ceilMin` is the
      // only direction under which the encoded obstacle contains the real one.
      const obstacle = card("fixed", t("2026-08-10T09:20:00Z"), 40 * MIN + 20 * SEC, "C1", "e-fixed");
      const movable = card("m1", t("2026-08-10T10:00:00Z"), 40 * MIN, "C1", "e-move");
      await expectMovedAndClean({
        proposal: [movable],
        existing: [obstacle],
        config: config(["C1"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "widens an immovable that STARTS mid-minute — a rounded-up start hands its first seconds away",
    async () => {
      // Obstacle starts 10:29:40; the movable runs 10:00–10:30. `roundMin` said
      // 10:30 and `start <= eStart - durMin` let the movable sit flush against a
      // boundary 20 seconds later than the real one. `floorMin` is the fix.
      const obstacle = card("fixed", t("2026-08-10T10:29:40Z"), 40 * MIN, "C1", "e-fixed");
      const movable = card("m1", t("2026-08-10T10:00:00Z"), 30 * MIN, "C1", "e-move");
      await expectMovedAndClean({
        proposal: [movable],
        existing: [obstacle],
        config: config(["C1"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "rounds a movable's own DURATION up — a rounded-down duration shortens the card z3 is packing",
    async () => {
      // Only the duration is off the minute: the movable runs 10:00:00–10:40:20
      // and the obstacle starts at a clean 10:40:00. `roundMin(40m20s)` is 40, so
      // the encoder packed a 40-minute card and left the last 20 seconds
      // overlapping. `ceilMin` is the only conservative direction for an extent.
      const obstacle = card("fixed", t("2026-08-10T10:40:00Z"), 40 * MIN, "C1", "e-fixed");
      const movable = card("m1", t("2026-08-10T10:00:00Z"), 40 * MIN + 20 * SEC, "C1", "e-move");
      await expectMovedAndClean({
        proposal: [movable],
        existing: [obstacle],
        config: config(["C1"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "rounds an immovable FEEDER's end up — it is a LOWER bound on the dependent's start",
    async () => {
      // `start_target >= end_source + rest`. Understating `end_source` weakens
      // the inequality, so the source's end must round UP. Different courts, so
      // `order` is the only family in play.
      const source = card("fixed", t("2026-08-10T09:20:00Z"), 40 * MIN + 20 * SEC, "C1", "e-fixed");
      const target = card("m1", t("2026-08-10T10:00:00Z"), 40 * MIN, "C2", "e-move");
      await expectMovedAndClean({
        proposal: [target],
        existing: [source],
        dependencies: [{ fixtureId: "m1", dependsOn: "fixed", direct: true }],
        config: config(["C1", "C2"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "rounds an immovable DEPENDENT's start down — it is the greater side of the same inequality",
    async () => {
      // Same inequality, opposite end: here the TARGET is immovable and its
      // start is the left-hand side. Overstating it satisfies the constraint on
      // paper, so it must round DOWN — the direction is a property of the
      // inequality, not of the field.
      const target = card("fixed", t("2026-08-10T10:00:40Z"), 40 * MIN, "C1", "e-fixed");
      const source = card("m1", t("2026-08-10T09:21:00Z"), 40 * MIN, "C2", "e-move");
      await expectMovedAndClean({
        proposal: [source],
        existing: [target],
        dependencies: [{ fixtureId: "fixed", dependsOn: "m1", direct: true }],
        config: config(["C1", "C2"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "rounds a movable's ORIGINAL start down — k=0 re-emits that instant to the millisecond",
    async () => {
      // The one place a MOVABLE start is not on the grid: `s.eq(origStartMin)`
      // keeps k=0 representable, and a fixture that does not move re-emits
      // `a.startAt` unrounded. So `origStartMin` is where the encoder says that
      // instant sits, and rounding it UP hides the seconds before it.
      //
      // This case survives the obstacle fix on its own: the obstacle ends
      // 10:00:55 → `ceilMin` 10:01, and `roundMin(10:00:50)` is ALSO 10:01, so
      // `start >= eEnd` still admitted a card really starting at 10:00:50.
      const obstacle = card("fixed", t("2026-08-10T09:20:00Z"), 40 * MIN + 55 * SEC, "C1", "e-fixed");
      const movable = card("m1", t("2026-08-10T10:00:50Z"), 40 * MIN, "C1", "e-move");
      await expectMovedAndClean({
        proposal: [movable],
        existing: [obstacle],
        config: config(["C1"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "covers the TAIL of an unmoved off-minute card — floor(start) + ceil(duration) is not enough",
    async () => {
      // The obstacle here is minute-aligned at BOTH ends and the duration is a
      // whole 30 minutes, so nothing but the original start is off the grid.
      //
      // 10:00:20 + 30 min really ends 10:30:20, but `floorMin(start) = 10:00`
      // plus `ceilMin(30 min) = 30` encodes an end of 10:30 — the fraction the
      // floor dropped off the head reappears at the tail. So the minutes a
      // fixture is packed with must cover its ORIGINAL placement as well as a
      // move onto the grid.
      const obstacle = card("fixed", t("2026-08-10T10:30:00Z"), 40 * MIN, "C1", "e-fixed");
      const movable = card("m1", t("2026-08-10T10:00:20Z"), 30 * MIN, "C1", "e-move");
      await expectMovedAndClean({
        proposal: [movable],
        existing: [obstacle],
        config: config(["C1"]),
        movedId: "m1",
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "will not let an off-minute original satisfy a not_before bound it really breaks",
    async () => {
      // The domain's lower bound is `ceilMin("09:00") = 09:00` — the safe
      // direction, untouched. What broke was the OTHER side of the comparison:
      // `roundMin(08:59:40)` is also 09:00, so the original placement satisfied
      // its own instruction and `s.eq(origStartMin)` kept it there at k=0.
      //
      // Reachable from the model, not from a fixture editor: an LLM start of
      // "…T08:59:40+00:00" clears `z.string().datetime({ offset: true })` and
      // survives `toMs` with its seconds intact.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1"]),
        ruleFixtures: [{ id: "m1", extKey: "m1", winnerTo: null }],
        hard: [{ type: "not_before", time: "09:00", scope: { kind: "competition" } }],
      };
      const movable = card("m1", t("2026-08-10T08:59:40Z"), 40 * MIN, "C1", "e-move");
      await expectMovedAndClean({ proposal: [movable], config: cfg, movedId: "m1" });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "buckets an off-minute start on the day the verifier counts it, not the next one",
    async () => {
      // `max_fixtures_per_day` is counted by `dayKeyInTz` in milliseconds and by
      // a per-day literal in minutes. A start of 23:59:40 rounded to nearest
      // becomes the next day's midnight, so the encoder satisfied a 1/day cap by
      // filing the card on a day the verifier never put it on.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1", "C2"]),
        window: { from: t("2026-08-10T00:00:00Z"), to: t("2026-08-13T00:00:00Z") },
        ruleFixtures: [
          { id: "late", extKey: "late", winnerTo: null },
          { id: "early", extKey: "early", winnerTo: null },
        ],
        hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } }],
      };
      // Both really fall on 2026-08-10, which is two under a cap of one.
      const late = card("late", t("2026-08-10T23:59:40Z"), 40 * MIN, "C1", "e-late");
      const early = card("early", t("2026-08-10T20:00:00Z"), 40 * MIN, "C2", "e-early");
      const proposal = [late, early];
      expect(validateAssignments(proposal, cfg)).not.toEqual([]);

      const r = await repairAndVerify({ proposal, config: cfg, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.relaxed).toEqual([]);
      // Either card may be the one that moves; what is not negotiable is that
      // ONE does, and that the two end up on different days.
      expect(r.moved).toHaveLength(1);
      expect(new Set(r.assignments.map((a) => dayKeyInTz(a.startAt, "UTC"))).size).toBe(2);
      expect(validateAssignments(r.assignments, cfg)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "refuses an off-minute original that really runs PAST the pack window",
    async () => {
      // `inRuns` bounds a start from ABOVE as well as below — the runs are legal
      // START instants already narrowed by the fixture's own duration, so
      // `window.to = 20:00` with a 40-minute card gives a run ending 19:20:00.
      //
      // `floorMin(19:20:40)` is that same 19:20 minute, so the unmoved escape
      // sat exactly on the bound and the encoder called a card that really runs
      // to 20:00:40 legal. Through `repairSchedule` — which is what both web
      // runners reach — that came back `repaired`, 40 seconds past the window,
      // with nothing thrown.
      const movable = card("m1", t("2026-08-10T19:20:40Z"), 40 * MIN, "C1", "e-move");
      await expectMovedAndClean({ proposal: [movable], config: config(["C1"]), movedId: "m1" });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "refuses an off-minute original that really runs INTO a blackout",
    async () => {
      // The same upper bound, reached through the fourth family. `blackout` runs
      // are per-court and subtract `bo.from - durationMs + 1`, so a 30-minute
      // card in front of a 12:00 blackout may start no later than 11:30:00.000 —
      // and `floorMin(11:30:40)` is 11:30.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1"]),
        blackouts: [{ from: t("2026-08-10T12:00:00Z"), to: t("2026-08-10T13:00:00Z") }],
      };
      const movable = card("m1", t("2026-08-10T11:30:40Z"), 30 * MIN, "C1", "e-move");
      await expectMovedAndClean({ proposal: [movable], config: cfg, movedId: "m1" });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "leaves an off-minute original alone when it is really LEGAL under not_after",
    async () => {
      // The other half of the same bound, and the reason it is not simply
      // `- 1 minute` everywhere. `hhmmInTz` truncates, so `not_after 19:00`
      // legitimately admits the whole 19:00 minute and a start at 19:00:40 is
      // LEGAL. Subtracting the slack alone would refuse it and move a card the
      // organiser placed correctly, so the original placement is added back as
      // an exact escape wherever it is really inside a run.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1"]),
        ruleFixtures: [
          { id: "clashing", extKey: "clashing", winnerTo: null },
          { id: "late", extKey: "late", winnerTo: null },
        ],
        hard: [{ type: "not_after", time: "19:00", scope: { kind: "competition" } }],
      };
      const obstacle = card("fixed", t("2026-08-10T15:00:00Z"), 40 * MIN, "C1", "e-fixed");
      const clashing = card("clashing", t("2026-08-10T15:00:00Z"), 40 * MIN, "C1", "e-clash");
      const late = card("late", t("2026-08-10T19:00:40Z"), 40 * MIN, "C1", "e-late");
      const proposal = [clashing, late];
      expect(validateAssignments(proposal, cfg, [obstacle])).not.toEqual([]);

      const r = await repairAndVerify({
        proposal,
        existing: [obstacle],
        config: cfg,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      // ONE move, and it is the card that was actually double-booked. `late`
      // keeps its instant, seconds and all.
      expect(r.moved).toEqual(["clashing"]);
      const byId = new Map(r.assignments.map((a) => [a.fixtureId, a]));
      expect(byId.get("late")!.startAt).toBe(t("2026-08-10T19:00:40Z"));
      expect(validateAssignments(r.assignments, cfg, [obstacle])).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "does not charge an unmoved card's extra minute to cards that really abut it",
    async () => {
      // Minimality, which is the property this wave exists to deliver.
      //
      // A ends 10:30:20 and B starts 10:30:20: `validateAssignments` lets
      // intervals touch, so the pair is legal exactly where it stands. On the
      // minute grid A is charged 31 minutes from 10:00 and B floors to 10:30, so
      // `30 >= 31` is false and the encoder invents a clash between two cards
      // that have none — turning a one-move board into a two-move board, and a
      // saturated court into a spurious `infeasible`.
      //
      // Only C is really in the way, so the minimal repair is to move C.
      const a = card("a", t("2026-08-10T10:00:20Z"), 30 * MIN, "C1", "e-a");
      const b = card("b", t("2026-08-10T10:30:20Z"), 30 * MIN, "C1", "e-b");
      const c = card("c", t("2026-08-10T10:15:00Z"), 30 * MIN, "C1", "e-c");
      const cfg = config(["C1"]);
      expect(validateAssignments([a, b, c], cfg)).not.toEqual([]);
      // The pair the encoder used to break is REALLY clean on its own.
      expect(validateAssignments([a, b], cfg)).toEqual([]);

      const r = await repairAndVerify({ proposal: [a, b, c], config: cfg, budgetMs: 60_000 });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.k).toBe(1);
      expect(r.moved).toEqual(["c"]);
      // And the two that stayed keep their instants to the millisecond.
      const byId = new Map(r.assignments.map((x) => [x.fixtureId, x]));
      expect(byId.get("a")!.startAt).toBe(t("2026-08-10T10:00:20Z"));
      expect(byId.get("b")!.startAt).toBe(t("2026-08-10T10:30:20Z"));
      expect(validateAssignments(r.assignments, cfg)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "fits a MOVED off-minute card into a hole exactly its own length",
    async () => {
      // The other half of "charge the still extent only when still". Both the
      // head slack and the tail minute are owed by the UNMOVED escape and by
      // nothing else, so a card that has been snapped to the grid must be
      // measured at exactly `ceilMin(duration)` from exactly `s`.
      //
      // The window runs 09:00-11:00 and obstacles hold 09:00-10:30 and
      // 11:00-12:00, so the only legal placement is 10:30-11:00 — a hole exactly
      // 30 minutes wide. A card charged 31 minutes, or pushed a minute earlier
      // by a slack it no longer owes, does not fit, and `court` is blocking, so
      // the answer is a final `infeasible` on a board with an obvious repair.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1"]),
        window: { from: t("2026-08-10T09:00:00Z"), to: t("2026-08-10T11:00:00Z") },
      };
      const before = card("o1", t("2026-08-10T09:00:00Z"), 90 * MIN, "C1", "e-o1");
      const after = card("o2", t("2026-08-10T11:00:00Z"), 60 * MIN, "C1", "e-o2");
      const movable = card("m1", t("2026-08-10T09:00:20Z"), 30 * MIN, "C1", "e-move");
      const existing = [before, after];
      expect(validateAssignments([movable], cfg, existing)).not.toEqual([]);

      const r = await repairAndVerify({
        proposal: [movable],
        existing,
        config: cfg,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.assignments[0]!.startAt).toBe(t("2026-08-10T10:30:00Z"));
      expect(validateAssignments(r.assignments, cfg, existing)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "does not charge an unmoved card's extra minute against an IMMOVABLE it really abuts",
    async () => {
      // The movable-versus-immovable form of the same minimality trap. `a` really
      // starts the instant the obstacle ends, which `validateAssignments`
      // accepts, but on the grid the obstacle's end ceils to 10:31 while `a`'s
      // start floors to 10:30. Without the original placement added back as an
      // exact fact, `a` is dragged off a slot it was entitled to keep.
      const obstacle = card("fixed", t("2026-08-10T10:00:20Z"), 30 * MIN, "C1", "e-fixed");
      const blocker = card("p", t("2026-08-10T09:00:00Z"), 40 * MIN, "C2", "e-p");
      const a = card("a", t("2026-08-10T10:30:20Z"), 30 * MIN, "C1", "e-a");
      const b = card("b", t("2026-08-10T09:00:00Z"), 40 * MIN, "C2", "e-b");
      const cfg = config(["C1", "C2"]);
      const existing = [obstacle, blocker];
      // `a` against the obstacle is clean on its own; only `b` is really in
      // anyone's way.
      expect(validateAssignments([a], cfg, [obstacle])).toEqual([]);
      expect(validateAssignments([a, b], cfg, existing)).not.toEqual([]);

      const r = await repairAndVerify({
        proposal: [a, b],
        existing,
        config: cfg,
        budgetMs: 60_000,
      });
      expect(r.status).toBe("repaired");
      if (r.status !== "repaired") return;
      expect(r.moved).toEqual(["b"]);
      const byId = new Map(r.assignments.map((x) => [x.fixtureId, x]));
      expect(byId.get("a")!.startAt).toBe(t("2026-08-10T10:30:20Z"));
      expect(validateAssignments(r.assignments, cfg, existing)).toEqual([]);
    },
    SOLVE_TIMEOUT,
  );

  it(
    "will not let a min_rest feeder rule ESCAPE on rounding — the escape clause rounds the other way",
    async () => {
      // `Or(start_dd < end_f, start_dd >= end_f + minutes)`. The first disjunct
      // says "the dependent starts before its feeder ends, so this is an
      // ordering problem and the rest rule does not measure it" — exactly the
      // `continue` `validateAssignments` makes. It is an ESCAPE, so it rounds
      // the opposite way to the constraint beside it: the dependent's start UP
      // and the feeder's end DOWN. Rounded to nearest it opens a gap, because
      // `round(start) + round(duration)` can overshoot `round(start + duration)`
      // by a minute and lift the encoded feeder end above the real one.
      //
      // Both ends are MOVABLE deliberately: `validateAssignments` measures this
      // rule off `assignments` alone, so a pair with an immovable end is never
      // measured and could not drift.
      const cfg: VerifyConfig & { courts: readonly string[] } = {
        ...config(["C1", "C2"]),
        ruleFixtures: STEP_RULE_FIXTURES.map((f) => ({ ...f })),
        hard: [
          {
            type: "min_rest_minutes",
            minutes: 90,
            rest_scope: "feeder_to_dependent",
            scope: { kind: "competition" },
          },
        ],
      };
      // Feeder 09:00:40 + 40m40s → 09:41:20; dependent starts on that instant,
      // so the verifier measures a gap of zero against a rule asking for 90.
      //
      // Built by hand rather than through `assign`: the STEP payload's shared
      // human would put these two under the `person` family as well, and the
      // over-wide encoded feeder this test is about would then be caught by
      // that instead — a pass proving nothing about the escape clause.
      const feeder = card("sl-g1-d1", t("2026-08-10T09:00:40Z"), 40 * MIN + 40 * SEC, "C1", "e-f");
      const dependent = card("sl-g2-d1", t("2026-08-10T09:41:20Z"), 40 * MIN, "C2", "e-d");
      await expectMovedAndClean({
        proposal: [feeder, dependent],
        config: cfg,
        movedId: "sl-g1-d1",
      });
    },
    SOLVE_TIMEOUT,
  );
});

/**
 * The nearest thing this package has to the probe that caught the other four
 * unit-mismatch bugs in this wave: a whole generated board handed to
 * `repairAndVerify`, which throws rather than returns when the solver's answer
 * and the verifier's disagree.
 *
 * `syntheticBoard` builds every start as a whole-minute offset from a
 * minute-aligned epoch — which is exactly why the generator has never been able
 * to see this class of bug. Jitter is applied here rather than in the generator
 * so the scale and decompose suites keep the board they were calibrated on.
 * Deterministic, not random: the same board twice, and a failure that can be
 * reproduced by reading the file.
 */
describe("a whole board with nothing on the minute", () => {
  it(
    "survives its own verifier once every start and end carries seconds",
    async () => {
      const board = syntheticBoard({ n: 20, clashEvery: 5 });
      expect(board.clashes).toBeGreaterThan(0);
      const jittered = board.proposal.map((a, i) => ({
        ...a,
        startAt: a.startAt + (((i * 37) % 59) + 1) * SEC,
        endAt: a.endAt + (((i * 23) % 59) + 1) * SEC,
      }));
      // No assertion on the STATUS beyond "it is one of the four": the point of
      // the probe is that `repairAndVerify` did not throw, which is the solver
      // defending every board it called clean.
      const r = await repairAndVerify({
        proposal: jittered,
        dependencies: board.dependencies,
        config: board.config,
        budgetMs: 60_000,
      });
      // NOT the full status union: `repairAndVerify` returns early for anything
      // other than `repaired`/`clean` and never re-runs the verifier, so an
      // `infeasible` or a `timeout` would pass this test having checked nothing.
      // Over-constraint makes `infeasible` a live outcome for exactly the
      // all-off-minute boards this probe builds, which is the shape it would
      // have quietly stopped covering.
      expect(["clean", "repaired"]).toContain(r.status);
    },
    SOLVE_TIMEOUT,
  );
});

// The boolean model, and NOTHING else.
//
// One variable per (fixture, slot). At most one slot per fixture; at most one
// fixture per slot. Everything the lattice already removed — blackouts, session
// windows, the competition window, court time a sibling occupies — is absent by
// construction and is not restated here.
//
// What IS stated here is every pairwise rule, and every one of them asks
// `calendar.ts` for the answer. This file contains no rule arithmetic of its
// own: the placer/verifier fork is the recurring defect in this subsystem, and
// it always arrives as a literal that looked harmless. The three numbers below
// (`pairRestMinutesFor`, `effectiveRestMinutes`, `startWindowFor`) are the
// verifier's own, and `build-encode-parity.test.ts` enumerates every placement
// two small lattices can express to prove the two agree placement by placement.
//
// The typed instruction rules `validateInstructionRules` evaluates —
// `max_fixtures_per_day`, `fixture_on_date`, `fixture_on_weekday`,
// `not_before`, `not_after` — are stated too, in section 9, and they ask the
// verifier itself for every verdict rather than restating one.
//
// WHAT IS NOT ENCODED, deliberately: the `min_rest_minutes` family. Its
// per-person half needs no clause of its own — it is folded into the rest bound
// `pairRestMinutesFor` already answers — and its `feeder_to_dependent` half,
// which `validateInstructionRules` reports as an `instruction` conflict over the
// `winnerTo` feed edges, has no clause here. A board this model calls feasible
// can therefore still carry that one conflict, which `build.ts` sees when it
// verifies the result. `build-encode-parity.test.ts` asserts its configs carry
// no UNENCODED rule type rather than assuming it, so the envelope is stated in
// the test rather than remembered and the next gap cannot hide.
//
// --- shape of the encoding -------------------------------------------------
//
// The obvious form of the pairwise rules — every fixture pair against every
// slot pair — is O(n²·|slots|²), which is ~10¹⁰ iterations at the 200-fixture /
// 250-slot target and does not finish. Two facts collapse it, and BOTH are
// exact rather than approximations (see `windowsOver`):
//
//   * a court clash does not care WHICH two fixtures collide, so it is one
//     at-most-one over a sliding window of same-court slots rather than a
//     clause per fixture pair — the whole n² factor disappears;
//   * a rest breach only ever binds two fixtures sharing a participant, and the
//     amount is a PAIR CONSTANT (nothing `pairRestMinutesWith` reads varies
//     with where a row is placed — `repair.ts` resolves a pair's rest off the
//     original board for the same reason), so it too is an at-most-one over a
//     sliding time window, per participant. Only the pairs that owe MORE than
//     their participant's cheapest pair need clauses of their own, over the
//     annulus between the two amounts.
import type { Bool, Model, Solver } from "z3-solver";
import type { BuildGrid } from "./build-grid.ts";
import {
  effectiveHard,
  effectiveRestMinutes,
  intervalsOverlap,
  pairRestMinutesFor,
  resolveSelector,
  scopeCoversFixture,
  startWindowFor,
  validateInstructionRules,
  type Assignment,
  type OrderDependency,
  type SchedulableFixture,
  type VerifyConfig,
} from "./calendar.ts";
import type { HardConstraint } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";
import type { Z3Context } from "./z3-load.ts";

const MS_PER_MIN = 60_000;

export type BuildConfig = VerifyConfig & { matchMinutes: number; courts: string[] };

export interface EncodeInput {
  Z3: Z3Context["Z3"];
  solver: Solver<"repair">;
  fixtures: readonly SchedulableFixture[];
  grid: BuildGrid;
  config: BuildConfig;
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
}

export interface EncodedModel {
  /** `place[f][s]` — fixture `f` occupies slot `s`. */
  place: Bool<"repair">[][];
  /** `placed[f]` — fixture `f` got a slot at all. T0 maximises the count of
   *  these, which is what turns greedy's `no_slot` GUESS into a PROOF. */
  placed: Bool<"repair">[];
  /** Read a solved model back into slot indexes, `null` for unplaced. */
  slotOf: (model: Model<"repair">) => (number | null)[];
  /** Turn slot indexes into the assignments the verifier will be handed. */
  assignmentsFrom: (picked: readonly (number | null)[]) => Assignment[];
}

export function encodeBuild(input: EncodeInput): EncodedModel {
  const { Z3, solver, fixtures, grid, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;
  const slots = grid.slots;
  const startOf = (s: number): number => slots[s]!.startAt;

  const asAssignment = (f: SchedulableFixture, slot: number): Assignment => ({
    fixtureId: f.id,
    court: slots[slot]!.court,
    startAt: slots[slot]!.startAt,
    endAt: slots[slot]!.startAt + durMs,
    entrants: [f.home, f.away].filter((e): e is string => e !== undefined),
    people: [...(f.people ?? [])],
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  });

  /**
   * A fixture's row with a PLACEHOLDER placement, for the questions whose
   * answer does not depend on one.
   *
   * `pairRestMinutesWith`, `effectiveRestMinutes`, `startWindowFor` and
   * `scopeCoversFixture` read a row's `fixtureId`, `entrants`, `people`,
   * `poolId` and `divisionId` and nothing else — never its court, never its
   * instants. So resolving rest or a start window once per FIXTURE gives the
   * same number as resolving it once per (fixture, slot), and the pruning below
   * depends on that being true. `repair.ts` leans on the identical fact: it
   * resolves a pair's rest from the ORIGINAL proposal rows, whatever placement
   * the solver later chooses for them.
   */
  const rowOf = (f: SchedulableFixture): Assignment => ({
    fixtureId: f.id,
    court: "",
    startAt: 0,
    endAt: durMs,
    entrants: [f.home, f.away].filter((e): e is string => e !== undefined),
    people: [...(f.people ?? [])],
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  });
  const rows = fixtures.map(rowOf);

  const place = fixtures.map((_, i) => slots.map((_s, s) => Z3.Bool.const(`x_${i}_${s}`)));
  const placed = fixtures.map((_, i) => Z3.Bool.const(`p_${i}`));

  /** Every slot index in ascending START order, across all courts. A court's
   *  own rows are already start-ordered by `buildGrid`'s (court, startAt) sort;
   *  the participant rules are court-blind and need the global order. */
  const byStart = slots.map((_, s) => s).sort((a, b) => startOf(a) - startOf(b) || a - b);

  const atMostOne = (lits: readonly Bool<"repair">[]): void => {
    if (lits.length < 2) return;
    solver.add(Z3.AtMost(lits as [Bool<"repair">, ...Bool<"repair">[]], 1));
  };

  /**
   * "Some fixture of `group` sits in slot `t`" — one literal per slot, defined
   * by an equivalence.
   *
   * An ABSTRACTION LAYER, and the reason every sliding window below costs
   * `|window|` literals rather than `|group| x |window|`. Stated directly, the
   * windows at 200 fixtures put ~1.5M literals into z3's cardinality
   * constraints and a bare `check()` stopped returning inside 20 s from n=100
   * upwards; through this layer the same model is ~5x smaller.
   *
   * It is exact ONLY BECAUSE at most one fixture may occupy a slot — an
   * occupancy literal cannot count to two, so without that constraint a window
   * would happily let two fixtures share one slot and every rule stated as a
   * window would leak. The per-slot AtMost below and this are a PAIR; removing
   * either alone silently un-states the other.
   */
  let occGroups = 0;
  const occupancyOf = (group: readonly number[]): Bool<"repair">[] => {
    const g = occGroups++;
    return slots.map((_sl, t) => {
      const occ = Z3.Bool.const(`o_${g}_${t}`);
      solver.add(occ.eq(Z3.Or(...group.map((i) => place[i]![t]!))));
      return occ;
    });
  };

  // 1. A fixture takes at most one slot, and `placed[i]` says whether it took
  //    one. Encoded as AtMost + an equivalence rather than exactly-one, because
  //    T0 needs "unplaced" to be a legal state it can then minimise.
  fixtures.forEach((_, i) => {
    if (slots.length === 0) {
      solver.add(Z3.Not(placed[i]!));
      return;
    }
    atMostOne(place[i]!);
    solver.add(placed[i]!.eq(Z3.Or(...place[i]!)));
  });

  // 2. A slot holds at most one fixture. Load-bearing twice over: it is half the
  //    court rule, and it is what makes every occupancy literal below exact.
  const anyFixture = fixtures.map((_, i) => i);
  slots.forEach((_sl, s) => atMostOne(anyFixture.map((i) => place[i]![s]!)));

  // 3. The rest of the court rule — the turnaround gap: at most one fixture in
  //    any run of same-court slots that starts inside one `matchMinutes +
  //    gapMinutes` interval. This is where the n² factor of the naive pair loop
  //    goes: two placements on one court that close together clash whoever they
  //    belong to, so the clause never needs to name a fixture pair at all.
  const occAny = occupancyOf(anyFixture);
  for (const rowsOnCourt of grid.byCourt.values()) {
    for (const window of windowsOver(rowsOnCourt, startOf, durMs + gapMs)) {
      atMostOne(window.map((s) => occAny[s]!));
    }
  }

  // 4. A fixture may only use a slot its own locked placement allows.
  fixtures.forEach((f, i) => {
    const locked = f.locked;
    if (locked === undefined) return;
    const s = slots.findIndex((sl) => sl.court === locked.court && sl.startAt === locked.startAt);
    // `buildGrid` admits every pinned placement, so -1 here is a programming
    // error in the caller, not an organiser input.
    if (s < 0) throw new Error(`locked slot missing from grid: ${f.id}`);
    solver.add(place[i]![s]!);
  });

  // 5. Start windows. `startWindowFor` is the verifier's own answer, and it
  //    bounds the START only, so one call per fixture answers for every slot.
  fixtures.forEach((_, i) => {
    const w = startWindowFor(config, rows[i]!);
    if (w.notBefore === -Infinity && w.notAfter === Infinity) return;
    slots.forEach((sl, s) => {
      if (sl.startAt < w.notBefore || sl.startAt > w.notAfter) solver.add(Z3.Not(place[i]![s]!));
    });
  });

  // 6. Rest and participant overlap between two MOVABLE fixtures.
  //
  //    `pairRestMinutesFor` is hoisted once — the un-hoisted wrapper made the
  //    equivalent loop 111x slower in `repair.ts`.
  const pairRest = pairRestMinutesFor(config);
  /** Fixture indexes by participant, namespaced so an entrant id can never
   *  collide with a person id — the identity seam this repo has hit eight
   *  times. `validateAssignments` matches entrants against entrants and people
   *  against people, never across, and so does this. */
  const byParticipant = new Map<string, number[]>();
  fixtures.forEach((_, i) => {
    for (const e of rows[i]!.entrants) pushTo(byParticipant, `e:${e}`, i);
    for (const p of rows[i]!.people) pushTo(byParticipant, `p:${p}`, i);
  });

  /** Pairs that owe MORE than the window their participant already imposes,
   *  keyed `i|j` with `i < j`. `covered` is the widest window any shared
   *  participant put over them, so the leftover clauses span only
   *  `[covered, needs)`. */
  const excess = new Map<string, { i: number; j: number; needs: number; covered: number }>();

  for (const group of byParticipant.values()) {
    if (group.length < 2) continue;
    // Rest is ASYMMETRIC: the amount owed depends on which row is asked about,
    // and `validateAssignments` evaluates a movable pair in BOTH directions
    // (every assignment is the outer `a` once), so the binding amount is the
    // max of the two.
    let narrowest = Infinity;
    const needs = new Map<string, number>();
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const i = group[x]!;
        const j = group[y]!;
        const d =
          durMs + Math.max(pairRest(rows[i]!, rows[j]!), pairRest(rows[j]!, rows[i]!)) * MS_PER_MIN;
        needs.set(`${i}|${j}`, d);
        if (d < narrowest) narrowest = d;
      }
    }
    // One window per participant, at the amount its CHEAPEST pair owes. Every
    // pair in the group owes at least that, so no pair is over-constrained, and
    // the pairs that owe more are topped up below.
    const occGroup = occupancyOf(group);
    for (const window of windowsOver(byStart, startOf, narrowest)) {
      atMostOne(window.map((s) => occGroup[s]!));
    }
    for (const [key, d] of needs) {
      const [i, j] = key.split("|").map(Number) as [number, number];
      const prior = excess.get(key);
      const covered = Math.max(prior?.covered ?? 0, narrowest);
      if (d <= covered) {
        if (prior !== undefined) excess.delete(key);
        continue;
      }
      excess.set(key, { i, j, needs: d, covered });
    }
  }

  // The leftover: a pair whose own rest exceeds the window its participants
  // already imposed. Only the ANNULUS `[covered, needs)` is left to state, and
  // for a board with one rest answer — which is nearly all of them — this loop
  // emits nothing at all.
  for (const { i, j, needs, covered } of excess.values()) {
    for (let a = 0; a < byStart.length; a++) {
      const s = byStart[a]!;
      for (let b = a + 1; b < byStart.length; b++) {
        const t = byStart[b]!;
        const delta = startOf(t) - startOf(s);
        if (delta < covered) continue;
        if (delta >= needs) break;
        solver.add(Z3.Not(Z3.And(place[i]![s]!, place[j]![t]!)));
        solver.add(Z3.Not(Z3.And(place[i]![t]!, place[j]![s]!)));
      }
    }
  }

  // 7. The same rules against every IMMOVABLE row (Gap 6). The lattice already
  //    removed their COURT time; their entrants, people and rest did not travel
  //    with it, and an encoder that stops at court time double-books a human
  //    across two divisions.
  //
  //    ONE DIRECTION, not the max: an `existing` row is never the outer `a` of
  //    `validateAssignments`, so the pair is judged exactly once and owes
  //    exactly `pairRest(movable, immovable)`. The max would refuse boards the
  //    verifier passes and report a spurious infeasible.
  fixtures.forEach((f, i) => {
    for (const e of existing) {
      const shares = sharesParticipant(rows[i]!, e);
      const restMs = shares ? pairRest(rows[i]!, e) * MS_PER_MIN : 0;
      const sameCourt = grid.byCourt.get(e.court);
      if (!shares && sameCourt === undefined) continue;
      // Prune WIDE and decide exactly inside: a slot can only be refused if its
      // start falls in this band, and every refusal below is still the full
      // `compatible` test rather than the band.
      const reach = Math.max(gapMs, restMs);
      const lo = e.startAt - durMs - reach;
      const hi = e.endAt + reach;
      for (const s of byStart) {
        const start = startOf(s);
        if (start <= lo) continue;
        if (start >= hi) break;
        if (compatibleWith(asAssignment(f, s), e, restMs)) continue;
        solver.add(Z3.Not(place[i]![s]!));
      }
    }
  });

  // 8. Order dependencies. A dependent may not start at its feeder's final
  //    whistle: the advancing player is a participant of the fixture they feed,
  //    so `validateAssignments` bounds the edge at `source.endAt +
  //    effectiveRestMinutes(config, target)` and this asks the same function
  //    for the same number.
  const indexOf = new Map(fixtures.map((f, i) => [f.id, i]));
  const existingById = new Map(existing.map((e) => [e.fixtureId, e]));
  for (const dep of dependencies) {
    const i = indexOf.get(dep.fixtureId);
    const j = indexOf.get(dep.dependsOn);
    const immovableTarget = existingById.get(dep.fixtureId);
    const immovableSource = existingById.get(dep.dependsOn);
    // The rest is the DEPENDENT's, resolved off its own row — placement-free,
    // exactly as in `validateAssignments`.
    const target = i !== undefined ? rows[i] : immovableTarget;
    if (target === undefined) continue;
    const restMs = effectiveRestMinutes(config, target) * MS_PER_MIN;

    if (i !== undefined && j !== undefined) {
      for (let b = 0; b < byStart.length; b++) {
        const t = byStart[b]!;
        const earliest = startOf(t) + durMs + restMs;
        for (let a = 0; a < byStart.length; a++) {
          const s = byStart[a]!;
          if (startOf(s) >= earliest) break;
          solver.add(Z3.Not(Z3.And(place[i]![s]!, place[j]![t]!)));
        }
      }
      continue;
    }
    if (i !== undefined && immovableSource !== undefined) {
      // Only the dependent moves; the feeder is where it says it is.
      const earliest = immovableSource.endAt + restMs;
      for (const s of byStart) {
        if (startOf(s) >= earliest) break;
        solver.add(Z3.Not(place[i]![s]!));
      }
      continue;
    }
    if (j !== undefined && immovableTarget !== undefined) {
      // The other way round — an immovable DEPENDENT bounds where its movable
      // feeder may sit, and dropping this half lets the solver place a feeder
      // after the fixture it feeds.
      const latestEnd = immovableTarget.startAt - restMs;
      for (const t of byStart) {
        if (startOf(t) + durMs > latestEnd) solver.add(Z3.Not(place[j]![t]!));
      }
    }
  }

  // 9. The typed instruction rules (#398) — the family `validateInstructionRules`
  //    evaluates and `slotFixtures` has placed around since #463.
  //
  //    Cheap here in a way the arithmetic encoding cannot be: slot → calendar
  //    day and slot → wall clock are known STATICALLY, so three of them are
  //    per-slot unary filters and the fourth is one `AtMost` per (rule, day).
  //    `repair.ts`'s `assertDayCap` needs auxiliary day literals, an `Iff` per
  //    (fixture, day) and a completeness clause purely because its starts are
  //    integers that can land anywhere.
  //
  //    NO RULE ARITHMETIC LIVES HERE, and none is even expressible: every unary
  //    verdict below is `validateInstructionRules`'s own, asked of a one-row
  //    board carrying that single rule. The encoder therefore cannot hold an
  //    opinion about what a rule means that differs from the referee's, which is
  //    the fork this file exists to avoid. The three placement rules read
  //    nothing off a row except its scope, so ONE probe per (rule, slot)
  //    answers for the whole scoped set.
  //
  //    THE ORG ZONE GATES THE BLOCK. Every rule here needs a day boundary or a
  //    wall clock, and the verifier skips all of them when `tz` is absent rather
  //    than bucketing in UTC (#448) — reporting a violation the organiser never
  //    expressed is worse than reporting none. An encoder that bucketed anyway
  //    would refuse boards the gate passes.
  const tz = config.tz;
  const hardRules = effectiveHard(config);
  if (tz !== undefined && hardRules.length > 0) {
    // `effectiveHard`, not `config.constraints.hard`: durable division rules and
    // the ones a run compiled from the organiser's instruction are ONE stream,
    // and a solver reading half of it enforces a rule on Monday and silently not
    // on Tuesday.
    const ruleFixtures = config.ruleFixtures ?? [];
    const ruleFixtureById = new Map(ruleFixtures.map((f) => [f.id, f]));
    const scopeCovers = (h: HardConstraint, i: number): boolean =>
      scopeCoversFixture(h.scope, ruleFixtureById.get(fixtures[i]!.id), rows[i]!);
    const scopedFixtures = (h: HardConstraint): number[] =>
      fixtures.flatMap((_f, i) => (scopeCovers(h, i) ? [i] : []));
    /** The slots this rule refuses outright for fixture `i` — the verifier's
     *  verdict on a board holding that one placement and that one rule. */
    const refusedSlots = (h: HardConstraint, i: number): number[] =>
      slots.flatMap((_sl, s) =>
        validateInstructionRules([asAssignment(fixtures[i]!, s)], { tz, hard: [h], ruleFixtures })
          .length > 0
          ? [s]
          : [],
      );

    for (const h of hardRules) {
      // `min_rest_minutes` is not a placement rule. Its per-person half is
      // already stated — `pairRestMinutesFor` folds it into the rest bound in
      // section 6, which is why it is deliberately absent from
      // `validateInstructionRules` too — and its feeder half is out of scope
      // here (see the header).
      if (h.type === "min_rest_minutes") continue;

      if (h.type === "not_before" || h.type === "not_after") {
        const scoped = scopedFixtures(h);
        if (scoped.length === 0) continue;
        for (const s of refusedSlots(h, scoped[0]!)) {
          for (const i of scoped) solver.add(Z3.Not(place[i]![s]!));
        }
        continue;
      }

      if (h.type === "fixture_on_date" || h.type === "fixture_on_weekday") {
        // The SELECTOR names which fixtures a date/weekday rule binds; the scope
        // only narrows what the selector may resolve to. "The final is on
        // Sunday" is competition-scoped and binds one fixture, so applying it to
        // every scoped row would empty the board.
        for (const f of resolveSelector(h.selector, h.scope, ruleFixtures)) {
          const i = indexOf.get(f.id);
          if (i === undefined) continue;
          if (!scopeCoversFixture(h.scope, f, rows[i]!)) continue;
          for (const s of refusedSlots(h, i)) solver.add(Z3.Not(place[i]![s]!));
        }
        continue;
      }

      // `max_fixtures_per_day`. THE UNIT IS THE CALENDAR DAY in the org zone,
      // the one `validateInstructionRules` tallies with `dayKeyInTz` — not a
      // session, not a slice of a day. `repair.ts:810` documents at length what
      // counting `dayBuckets` instead cost: once `sessionWindows` is non-empty a
      // morning and an afternoon session are two buckets sharing one ymd, so a
      // `count: 1` cap admitted one fixture per SESSION, and the clipped first
      // and last buckets let a start land in a gap that no bucket counted.
      //
      // No `calendarDaysCovering` walk and no completeness clause are needed to
      // say it here: the only starts that exist are slot starts, so grouping the
      // slots themselves by day covers every reachable start by construction.
      const scoped = scopedFixtures(h);
      if (scoped.length === 0) continue;
      const byDay = new Map<string, number[]>();
      slots.forEach((sl, s) => pushTo(byDay, dayKeyInTz(sl.startAt, tz), s));
      const binding = [...byDay].flatMap(([ymd, daySlots]) => {
        // Only KNOWN FIXTURES seed the tally. An outside booking or a closed
        // court is not a fixture, and counting one would invent a cap breach out
        // of a blackout — `validateInstructionRules` filters `existing` through
        // `ruleFixtures` for exactly that reason, and this repeats the filter
        // rather than approximating it.
        const immovable = existing.filter(
          (e) =>
            ruleFixtureById.has(e.fixtureId) &&
            scopeCoversFixture(h.scope, ruleFixtureById.get(e.fixtureId), e) &&
            dayKeyInTz(e.startAt, tz) === ymd,
        ).length;
        const room = Math.max(0, h.count - immovable);
        // A day with no more slots than room left can never breach; saying so
        // costs clauses and buys nothing.
        return room >= daySlots.length ? [] : [{ daySlots, room }];
      });
      if (binding.length === 0) continue;
      // One occupancy literal per slot over the scoped fixtures, so a day's
      // clause costs |slots in day| rather than |scoped| x |slots in day|. Exact
      // for the same reason as every other window in this file, and by the same
      // premise: the per-slot AtMost in section 2 means an occupancy literal
      // cannot count to two.
      const occScoped = occupancyOf(scoped);
      for (const { daySlots, room } of binding) {
        if (room === 0) {
          for (const s of daySlots) solver.add(Z3.Not(occScoped[s]!));
          continue;
        }
        const lits = daySlots.map((s) => occScoped[s]!);
        solver.add(Z3.AtMost([lits[0]!, ...lits.slice(1)], room));
      }
    }
  }

  /** Two placements that may coexist, with `restMs` already resolved for the
   *  DIRECTION this pair is judged in. The only place this file decides
   *  anything, and every term in it is a `calendar.ts` answer. */
  function compatibleWith(a: Assignment, b: Assignment, restMs: number): boolean {
    if (
      a.court === b.court &&
      intervalsOverlap(a.startAt, a.endAt + gapMs, b.startAt, b.endAt + gapMs)
    ) {
      return false;
    }
    if (!sharesParticipant(a, b)) return true;
    return !intervalsOverlap(a.startAt, a.endAt + restMs, b.startAt, b.endAt + restMs);
  }

  return {
    place,
    placed,
    slotOf: (model) =>
      fixtures.map((_, i) => {
        // `Z3.isTrue` on a COMPLETED evaluation rather than a string compare:
        // an unconstrained literal evaluates back to itself, which no string
        // test reads correctly, and model completion is also what keeps two
        // runs of the same solved model reading the same board.
        const s = slots.findIndex((_sl, si) => Z3.isTrue(model.eval(place[i]![si]!, true)));
        return s < 0 ? null : s;
      }),
    assignmentsFrom: (picked) =>
      fixtures.flatMap((f, i) => {
        const s = picked[i];
        return s === null || s === undefined ? [] : [asAssignment(f, s)];
      }),
  };
}

/**
 * Every maximal run of slots whose starts fall inside one half-open interval of
 * `width`, anchored at each member's own start.
 *
 * THE EXACTNESS ARGUMENT, because everything above rests on it:
 *
 *   * nothing is over-constrained — two slots inside one window are strictly
 *     less than `width` apart, so any rule of the form "these two placements
 *     must be `width` apart" genuinely forbids them both;
 *   * nothing is dropped — if two slots ARE closer than `width`, the window
 *     anchored at the earlier one contains both, and every slot is an anchor.
 *
 * So an at-most-one over a window's placements says exactly what a clause per
 * slot pair would say, in `|slots|` constraints instead of `|slots|²` clauses
 * per fixture pair.
 *
 * `order` must be ascending by start. A window whose run ends where the
 * previous one did is implied by it and is skipped.
 */
function* windowsOver(
  order: readonly number[],
  startOf: (s: number) => number,
  width: number,
): Generator<readonly number[]> {
  let prevEnd = -1;
  for (let a = 0; a < order.length; a++) {
    let b = a;
    while (b + 1 < order.length && startOf(order[b + 1]!) < startOf(order[a]!) + width) b++;
    if (a > 0 && b === prevEnd) continue;
    prevEnd = b;
    yield order.slice(a, b + 1);
  }
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [value]);
  else rows.push(value);
}

function sharesParticipant(a: Assignment, b: Assignment): boolean {
  return a.entrants.some((e) => b.entrants.includes(e)) || a.people.some((p) => b.people.includes(p));
}

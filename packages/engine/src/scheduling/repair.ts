// Minimal-movement schedule repair (#401).
//
// The solver half. It takes an AI-proposed board the verifier rejects and finds
// the FEWEST fixture moves that make the verifier accept it — minimality by
// ascending k with push/pop, so the first satisfiable k is the minimum by
// construction rather than by an objective function nobody can audit.
//
// Minimal movement is a SAFETY property, not an optimisation: a repair that
// reshuffles a published schedule to save the solver a second has told every
// entrant the wrong time. It is never traded for speed.
//
// Three rules this file obeys without exception:
//
//   1. It never re-derives a rule semantic. Rest amounts, scope coverage,
//      selector resolution and the merged hard-rule stream all come from
//      `calendar.ts`; every calendar decision comes from `repair-domain.ts`.
//      A solver with its own idea of the rules produces boards the verifier
//      rejects, which is the exact lock-out this wave exists to prevent.
//   2. It never loads z3 for a board that already verifies. `z3LoadCount()`
//      makes that a test rather than a promise.
//   3. It never throws on exhaustion. A finite wall-clock budget with a
//      `timeout` result is what lets the caller fall back to LLM repair; an
//      exception there would present an unrepaired plan as a crash.
import type { Arith, Bool } from "z3-solver";
import type { HardConstraint } from "./constraints.ts";
import {
  effectiveHard,
  effectiveRestMinutes,
  isBlockingConflict,
  pairRestMinutesFor,
  scopeCoversFixture,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type RuleFixture,
  type VerifyConfig,
} from "./calendar.ts";
import {
  buildDomains,
  candidatePairs,
  dayBuckets,
  maxSeparationMinutes,
  repairCourts,
  repairUniverse,
  sortFamilies,
  BLOCKING_FAMILIES,
  REPAIR_FAMILIES,
  type RepairFamily,
} from "./repair-domain.ts";
import { dayKeyInTz } from "./tz.ts";
import { loadZ3 } from "./z3-load.ts";

/** #401's Task 4 interface names these on `repair.ts`; they are DEFINED in
 *  `repair-domain.ts` because the domain builder is what decides which family a
 *  bound belongs to. Re-exported rather than redeclared — the same bindings, so
 *  the scheduling barrel's two `export *` resolve to one declaration each. */
export { BLOCKING_FAMILIES, REPAIR_FAMILIES, type RepairFamily };

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/** Minutes. The lattice repaired starts snap to; a fixture's ORIGINAL start is
 *  always legal even when it is off-grid, so k=0 is always representable. */
export const REPAIR_GRID_MINUTES = 5;

/** Wall-clock ceiling on one solve. Provisional until #401's bench (Task 6)
 *  measures 50/120/250/500 movable and replaces this with the measured number. */
export const DEFAULT_REPAIR_BUDGET_MS = 15_000;

export interface RepairInput {
  proposal: readonly Assignment[]; // the fixtures this run may move
  existing?: readonly Assignment[]; // immovable board + obstacles
  dependencies?: readonly OrderDependency[];
  config: VerifyConfig & { courts: readonly string[] };
  budgetMs?: number; // default DEFAULT_REPAIR_BUDGET_MS
  gridMinutes?: number;
  onProgress?: (p: { k: number; elapsedMs: number }) => void;
}

export type RepairResult =
  | {
      status: "clean";
      assignments: readonly Assignment[];
      moved: readonly string[];
      k: 0;
      elapsedMs: number;
      checks: number;
      relaxed: readonly RepairFamily[];
    }
  | {
      status: "repaired";
      assignments: readonly Assignment[];
      moved: readonly string[];
      k: number;
      elapsedMs: number;
      checks: number;
      relaxed: readonly RepairFamily[];
    }
  | { status: "infeasible"; families: readonly RepairFamily[]; elapsedMs: number; checks: number }
  | { status: "timeout"; lastK: number; elapsedMs: number; checks: number };

/**
 * Which way the solver and the verifier disagreed.
 *
 *   `verifier_rejected` — the solve finished, moved cards, and the REAL verifier
 *     still rejects the board. Caught by `repairAndVerify`.
 *   `encoding_drift` — the solver found a model in which NOTHING moves, on a
 *     board the verifier had already rejected before z3 was loaded. Zero moves
 *     is only reachable when the encoding lost a constraint, so this one is
 *     raised inside `repairSchedule` itself: returning `status: "clean"` there
 *     laundered a missing constraint past every caller that uses
 *     `repairSchedule` directly rather than `repairAndVerify` — and both web
 *     runners do.
 */
export type RepairFailureKind = "verifier_rejected" | "encoding_drift";

/** Thrown when a "repaired" schedule fails the REAL verifier, or when the
 *  encoding provably lost a constraint. An impossible event that occurs should
 *  be loud: the alternative is shipping a board the organiser cannot then
 *  edit. */
export class RepairVerificationError extends Error {
  readonly conflicts: readonly Conflict[];
  readonly result: RepairResult;
  readonly kind: RepairFailureKind;
  constructor(
    message: string,
    conflicts: readonly Conflict[],
    result: RepairResult,
    kind: RepairFailureKind = "verifier_rejected",
  ) {
    super(message);
    this.name = "RepairVerificationError";
    this.conflicts = conflicts;
    this.result = result;
    this.kind = kind;
  }
}

const ceilMin = (ms: number): number => Math.ceil(ms / MS_PER_MIN);
const floorMin = (ms: number): number => Math.floor(ms / MS_PER_MIN);
const roundMin = (ms: number): number => Math.round(ms / MS_PER_MIN);

/** z3 renders `|fam:court|` quoted when an assumption name contains a colon,
 *  which then does not match on the way back out of the unsat core. */
const famLiteralName = (f: RepairFamily): string => `fam_${f}`;

export async function repairSchedule(input: RepairInput): Promise<RepairResult> {
  // `performance.now()` rather than `Date.now()`: ambient wall-clock reads are
  // banned engine-wide (scripts/engine-boundary.ts), and an elapsed span is what
  // a monotonic clock is for anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const budgetMs = input.budgetMs ?? DEFAULT_REPAIR_BUDGET_MS;
  const { config, proposal } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];

  // The budget covers the WHOLE call, not just `check()`. Booting the WASM and
  // walking the O(n²) encode are both real wall-clock, and with the first budget
  // test after all of it a `budgetMs: 15_000` call could return `timeout` having
  // burned far more. `checks` and `timeout` are hoisted above the encode so the
  // early exits can use them.
  let checks = 0;
  const timeout = (lastK: number): RepairResult => ({
    status: "timeout",
    lastK,
    elapsedMs: elapsed(),
    checks,
  });
  const overBudget = (): boolean => elapsed() >= budgetMs;

  // 1. A board that already verifies is answered WITHOUT loading the WASM.
  const pre = validateAssignments(proposal, config, existing, dependencies);
  if (pre.length === 0) {
    return {
      status: "clean",
      assignments: [...proposal],
      moved: [],
      k: 0,
      elapsedMs: elapsed(),
      checks: 0,
      relaxed: [],
    };
  }

  // Loading the WASM is ~160 ms cold and is not free to a caller who has already
  // spent its budget verifying.
  if (overBudget()) return timeout(0);
  const { Z3 } = await loadZ3();
  const solver = new Z3.Solver();

  const domainInput = { proposal, existing, config };
  const domains = buildDomains(domainInput);
  const courts = repairCourts(domainInput);
  const universe = repairUniverse(domainInput);
  const buckets = dayBuckets({
    tz: config.tz,
    window: universe,
    sessionWindows: config.sessionWindows,
  });
  const grid = input.gridMinutes ?? REPAIR_GRID_MINUTES;
  const gapMin = config.gapMinutes;
  const pairRest = pairRestMinutesFor(config);
  const hard = effectiveHard(config);
  const ruleFixtures = config.ruleFixtures ?? [];
  const fixtureById = new Map<string, RuleFixture>(ruleFixtures.map((f) => [f.id, f]));
  const proposalById = new Map(proposal.map((a) => [a.fixtureId, a]));
  const boardById = new Map([...existing, ...proposal].map((a) => [a.fixtureId, a]));
  const courtIndex = new Map(courts.map((c, i) => [c, i]));

  const idx = new Map(domains.map((d, i) => [d.fixtureId, i]));
  const start = domains.map((_, i) => Z3.Int.const(`s_${i}`));
  const courtVar = domains.map((_, i) => Z3.Int.const(`c_${i}`));
  const movedVar = domains.map((_, i) => Z3.Bool.const(`m_${i}`));
  const durMin = domains.map((d) => roundMin(d.durationMs));
  const origStartMin = domains.map((d) => roundMin(d.origStartAt));
  const origCourtIdx = domains.map((d) => courtIndex.get(d.origCourt) ?? 0);

  const fam = Object.fromEntries(
    REPAIR_FAMILIES.map((f) => [f, Z3.Bool.const(famLiteralName(f))]),
  ) as Record<RepairFamily, Bool<"repair">>;
  const assume = (family: RepairFamily, e: Bool<"repair">): void => {
    solver.add(Z3.Implies(fam[family], e));
  };

  const TRUE = Z3.And();
  const FALSE = Z3.Or();
  const inRuns = (x: Arith<"repair">, runs: readonly { from: number; to: number }[]): Bool<"repair"> =>
    runs.length === 0
      ? FALSE
      : Z3.Or(...runs.map((r) => Z3.And(x.ge(ceilMin(r.from)), x.le(floorMin(r.to)))));

  // --- per-fixture structure ------------------------------------------------
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i]!;
    const s = start[i]!;

    // A FINITE-MODEL GUARD, and nothing else. Without it z3 is free to answer
    // with the year 90210, so every start carries an unconditional bound.
    //
    // It does NOT compete with the pack window: `window` sits in
    // `BLOCKING_FAMILIES` and is therefore never relaxed, so there is no
    // fallback path on which this bound is the only thing left holding a start
    // inside the competition. Where it actually binds is the config with no pack
    // window AND no session windows — `repairUniverse` then returns the board's
    // own extent widened by a week, `byFamily.window` is absent entirely, and
    // this ±30 days is the only bound on the integer.
    solver.add(
      s.ge(floorMin(universe.from - 30 * MS_PER_DAY)),
      s.le(ceilMin(universe.to + 30 * MS_PER_DAY)),
    );
    // The original placement is always legal, so k=0 stays representable even
    // when the LLM placed a card off-grid.
    solver.add(Z3.Or(s.mod(grid).eq(0), s.eq(origStartMin[i]!)));

    // A fixture may take any configured court, plus the one it is already on —
    // an unlisted original court would otherwise force it to move.
    const allowed = new Set<number>([origCourtIdx[i]!]);
    for (const c of config.courts) {
      const ci = courtIndex.get(c);
      if (ci !== undefined) allowed.add(ci);
    }
    solver.add(Z3.Or(...[...allowed].sort((a, b) => a - b).map((ci) => courtVar[i]!.eq(ci))));

    for (const family of ["window", "instruction", "start_window"] as const) {
      const runs = d.byFamily[family];
      if (runs !== undefined) assume(family, inRuns(s, runs));
    }
    if (d.byFamily.blackout !== undefined) {
      for (const c of courts) {
        const ci = courtIndex.get(c)!;
        assume("blackout", Z3.Implies(courtVar[i]!.eq(ci), inRuns(s, d.courtIntervals[c] ?? [])));
      }
    }

    // Movement is start OR court: a card dragged to another court at the same
    // time has moved, and an organiser who published it will be told so.
    solver.add(
      Z3.Iff(
        movedVar[i]!,
        Z3.Or(s.neq(origStartMin[i]!), courtVar[i]!.neq(origCourtIdx[i]!)),
      ),
    );
  }

  // --- movable × movable ----------------------------------------------------
  // `candidatePairs` has already dropped every pair that cannot come within the
  // separation it might owe; this is the O(n²) loop the pruner exists for. The
  // slack is what stops it dropping a pair that never overlaps but still owes
  // rest.
  const pairs = candidatePairs(domains, maxSeparationMinutes(config) * MS_PER_MIN);
  for (let p = 0; p < pairs.length; p++) {
    // 125k pairs at the 500-fixture cap, each one several z3 term allocations.
    // Sampled rather than tested every iteration: `performance.now()` in the
    // hot loop would itself be a measurable share of the encode.
    if ((p & 0x3ff) === 0 && overBudget()) return timeout(0);
    const [i, j] = pairs[p]!;
    const ai = proposalById.get(domains[i]!.fixtureId)!;
    const aj = proposalById.get(domains[j]!.fixtureId)!;
    const sep = (r: number): Bool<"repair"> =>
      Z3.Or(
        start[i]!.ge(start[j]!.add(durMin[j]! + r)),
        start[j]!.ge(start[i]!.add(durMin[i]! + r)),
      );
    assume("court", Z3.Implies(courtVar[i]!.eq(courtVar[j]!), sep(gapMin)));
    if (sharesParticipant(ai, aj)) {
      // Overlap is blocking and rest is not, so they are asserted under
      // SEPARATE literals even though the arithmetic is one form: relaxing
      // `rest` must never let two cards for the same human overlap.
      assume("person", sep(0));
      // BOTH orderings, because `validateAssignments` evaluates both: it loops
      // every assignment as the outer `a`, and `pairRestMinutes` reads the first
      // argument's pool/division.
      const r = Math.max(pairRest(ai, aj), pairRest(aj, ai));
      if (r > 0) assume("rest", sep(r));
    }
  }

  // --- movable × immovable --------------------------------------------------
  for (let i = 0; i < domains.length; i++) {
    if ((i & 0x3f) === 0 && overBudget()) return timeout(0);
    const d = domains[i]!;
    const ai = proposalById.get(d.fixtureId)!;
    // A `null` span means the blocking families alone leave this fixture nowhere
    // to stand — which is a reason to encode it MORE carefully, not to skip it.
    // Skipping was how a fixture with an unsatisfiable instruction reached z3
    // carrying no court or person constraint at all. Only the PRUNE below needs
    // a span; without one every immovable is encoded.
    const spanFrom = d.span === null ? null : ceilMin(d.span.from);
    const spanTo = d.span === null ? null : floorMin(d.span.to);
    for (const e of existing) {
      const eStart = roundMin(e.startAt);
      const eEnd = roundMin(e.endAt);
      // Only the MOVABLE side is ever the outer `a` in `validateAssignments`,
      // so this pair is judged one-directionally and owes exactly this number —
      // NOT the max. The max would over-constrain and report a spurious
      // infeasible on a board the verifier passes.
      const rest = sharesParticipant(ai, e) ? pairRest(ai, e) : 0;
      const reach = Math.max(gapMin, rest);
      if (
        spanFrom !== null &&
        spanTo !== null &&
        (spanFrom >= eEnd + reach || spanTo + durMin[i]! + reach <= eStart)
      ) {
        continue;
      }
      const clear = (r: number): Bool<"repair"> =>
        Z3.Or(start[i]!.ge(eEnd + r), start[i]!.le(eStart - durMin[i]! - r));
      const ci = courtIndex.get(e.court);
      if (ci !== undefined) assume("court", Z3.Implies(courtVar[i]!.eq(ci), clear(gapMin)));
      if (sharesParticipant(ai, e)) {
        assume("person", clear(0));
        if (rest > 0) assume("rest", clear(rest));
      }
    }
  }

  // --- feed order -----------------------------------------------------------
  // `start_target >= end_source + effectiveRestMinutes(config, target)` — the
  // feeder-rest semantic from calendar.ts, not a re-derivation of it. The
  // advancing player is a participant of the fixture they feed, so a dependent
  // may not start at the feeder's final whistle.
  const startExpr = (id: string): Arith<"repair"> | number => {
    const i = idx.get(id);
    return i !== undefined ? start[i]! : roundMin(boardById.get(id)!.startAt);
  };
  const endExpr = (id: string): Arith<"repair"> | number => {
    const i = idx.get(id);
    return i !== undefined ? start[i]!.add(durMin[i]!) : roundMin(boardById.get(id)!.endAt);
  };
  const plus = (x: Arith<"repair"> | number, n: number): Arith<"repair"> | number =>
    typeof x === "number" ? x + n : x.add(n);
  const geq = (a: Arith<"repair"> | number, b: Arith<"repair"> | number): Bool<"repair"> => {
    if (typeof a !== "number") return a.ge(b);
    if (typeof b !== "number") return b.le(a);
    return a >= b ? TRUE : FALSE;
  };
  const lt = (a: Arith<"repair"> | number, b: Arith<"repair"> | number): Bool<"repair"> => {
    if (typeof a !== "number") return a.lt(b);
    if (typeof b !== "number") return b.gt(a);
    return a < b ? TRUE : FALSE;
  };

  for (const dep of dependencies) {
    const target = boardById.get(dep.fixtureId);
    const source = boardById.get(dep.dependsOn);
    // A dependency whose source is not on the board constrains nothing yet —
    // the same skip `validateAssignments` makes.
    if (target === undefined || source === undefined) continue;
    // A dep with BOTH ends immovable used to be skipped. `validateAssignments`
    // still reports it — its `byId` covers `existing` too — so the skip handed
    // back a "repaired" board carrying a blocking `order` conflict and
    // `repairAndVerify` threw on an input nothing could have fixed. Encoded
    // instead: both sides are constants, `geq` collapses to true or false, and a
    // genuinely impossible pre-existing order becomes an honest `infeasible`
    // naming `order` rather than an exception.
    const rest = effectiveRestMinutes(config, target);
    // Indirect feeds are NOT blocking to the verifier (`isBlockingConflict`
    // covers `order` only when `direct === true`), so they go under their own
    // relaxable literal. Under `order` they made the relaxed path report
    // `infeasible` over a conflict the verifier merely warns about.
    assume(
      dep.direct === true ? "order" : "order_soft",
      geq(startExpr(dep.fixtureId), plus(endExpr(dep.dependsOn), rest)),
    );
  }

  // --- typed instruction rules ---------------------------------------------
  // Placement rules (`fixture_on_*`, `not_before`, `not_after`) are already
  // intervals on `byFamily.instruction`. What is left is the two rule types
  // that are not a per-fixture bound: a feeder→dependent rest, and a per-day
  // cap that counts the WHOLE board.
  const tz = config.tz;
  if (tz !== undefined) {
    for (let h = 0; h < hard.length; h++) {
      const rule = hard[h]!;
      if (rule.type === "min_rest_minutes") {
        if (rule.rest_scope === "per_person") continue; // folded into pairRest
        for (const f of ruleFixtures) {
          if (f.winnerTo === null) continue;
          const feeder = boardById.get(f.id);
          if (feeder === undefined) continue;
          for (const dd of ruleFixtures) {
            // The feed edge, by the same ext_key the bracket is wired with, and
            // within one division — two divisions can reuse a key like "SF1".
            if (dd.extKey !== f.winnerTo || dd.divisionId !== f.divisionId) continue;
            const dependent = boardById.get(dd.id);
            if (dependent === undefined) continue;
            if (!idx.has(f.id) && !idx.has(dd.id)) continue;
            if (!scopeCoversFixture(rule.scope, f, feeder) && !scopeCoversFixture(rule.scope, dd, dependent)) {
              continue;
            }
            // Only a dependent placed AFTER its feeder is measured — one placed
            // before is an ordering violation and is reported as `order`.
            assume(
              "instruction",
              Z3.Or(
                lt(startExpr(dd.id), endExpr(f.id)),
                geq(startExpr(dd.id), plus(endExpr(f.id), rule.minutes)),
              ),
            );
          }
        }
        continue;
      }
      if (rule.type === "max_fixtures_per_day") {
        assertDayCap(rule, h);
      }
    }
  }

  function assertDayCap(rule: Extract<HardConstraint, { type: "max_fixtures_per_day" }>, h: number): void {
    const zone = tz!;
    const scoped: number[] = [];
    for (let i = 0; i < domains.length; i++) {
      const a = proposalById.get(domains[i]!.fixtureId)!;
      if (scopeCoversFixture(rule.scope, fixtureById.get(a.fixtureId), a)) scoped.push(i);
    }
    if (scoped.length === 0) return;
    // A BUCKET IS NOT A DAY. `dayBuckets` returns one bucket per SESSION as soon
    // as `sessionWindows` is non-empty, so a morning and an afternoon session on
    // one calendar day are two buckets sharing one `ymd`. Asserted per bucket, a
    // `count: 1` cap admitted one fixture per session — two per day — and the
    // verifier, which counts per day, then rejected the board the solver called
    // repaired. Same root cause as the session/window mix-up: an encoder unit
    // that is not the verifier's unit.
    //
    // So the buckets are folded back into days, ONE `AtMost` per day over the
    // union of that day's runs, and the immovable count is subtracted ONCE from
    // the day rather than once from every session on it. Days are keyed by the
    // verifier's own `dayKeyInTz` and sorted explicitly — `YYYY-MM-DD` sorts
    // chronologically — so the assertion order is a function of the input, never
    // of Map iteration.
    const byDay = new Map<string, { from: number; to: number }[]>();
    for (const bucket of buckets) {
      const runs = byDay.get(bucket.ymd);
      if (runs === undefined) byDay.set(bucket.ymd, [{ from: bucket.from, to: bucket.to }]);
      else runs.push({ from: bucket.from, to: bucket.to });
    }
    const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let g = 0; g < days.length; g++) {
      const [ymd, runs] = days[g]!;
      const lits = scoped.map((i) => {
        const lit = Z3.Bool.const(`day_${h}_${g}_${i}`);
        // "starts on this day" is the OR over the day's runs: a card in EITHER
        // session counts once against the one cap.
        solver.add(
          Z3.Iff(
            lit,
            Z3.Or(
              ...runs.map((r) =>
                Z3.And(start[i]!.ge(ceilMin(r.from)), start[i]!.le(floorMin(r.to - 1))),
              ),
            ),
          ),
        );
        return lit;
      });
      // Only KNOWN FIXTURES count: an outside booking or a closed court is not a
      // fixture, and counting one would invent a cap breach out of a blackout.
      const immovable = existing.filter(
        (e) =>
          fixtureById.has(e.fixtureId) &&
          scopeCoversFixture(rule.scope, fixtureById.get(e.fixtureId), e) &&
          dayKeyInTz(e.startAt, zone) === ymd,
      ).length;
      assume(
        "instruction",
        Z3.AtMost([lits[0]!, ...lits.slice(1)], Math.max(0, rule.count - immovable)),
      );
    }
  }

  // --- search ---------------------------------------------------------------
  type CheckOutcome = "sat" | "unsat" | "budget";
  const check = async (assumptions: readonly Bool<"repair">[]): Promise<CheckOutcome> => {
    const remaining = budgetMs - elapsed();
    if (remaining <= 0) return "budget";
    solver.set("timeout", Math.max(1, Math.ceil(remaining)));
    checks++;
    const res = await solver.check(...assumptions);
    // An `unknown` here is exhaustion, not an error to raise: the caller's LLM
    // fallback is the designed behaviour and a throw would deny it.
    return res === "unknown" ? "budget" : res;
  };
  const coreFamilies = (): RepairFamily[] => {
    const names = new Set([...solver.unsatCore()].map((e) => e.toString()));
    return sortFamilies(REPAIR_FAMILIES.filter((f) => names.has(famLiteralName(f))));
  };

  // 3. Feasibility probe FIRST, with no `AtMost` bound. A genuinely impossible
  // board fails here instead of walking every k to discover the same thing.
  let inPlay: readonly RepairFamily[] = REPAIR_FAMILIES;
  let relaxed: RepairFamily[] = [];
  const probe = await check(REPAIR_FAMILIES.map((f) => fam[f]));
  if (probe === "budget") return timeout(0);
  if (probe === "unsat") {
    const fullCore = coreFamilies();
    // 5. Is a PHYSICALLY POSSIBLE board reachable at all? If so, repair to that
    // and tell the caller exactly which comforts were dropped to get there.
    const fallback = await check(BLOCKING_FAMILIES.map((f) => fam[f]));
    if (fallback === "budget") return timeout(0);
    if (fallback === "unsat") {
      const core = coreFamilies();
      return {
        status: "infeasible",
        families: core.length > 0 ? core : fullCore,
        elapsedMs: elapsed(),
        checks,
      };
    }
    inPlay = BLOCKING_FAMILIES;
    relaxed = sortFamilies(REPAIR_FAMILIES.filter((f) => !BLOCKING_FAMILIES.includes(f)));
  }

  // 4. Ascending k. The first `sat` is the minimum BY CONSTRUCTION — no
  // objective function, nothing to audit, nothing to trade away.
  const assumptions = inPlay.map((f) => fam[f]);
  const bounded: [Bool<"repair">, ...Bool<"repair">[]] = [movedVar[0]!, ...movedVar.slice(1)];
  for (let k = 0; k <= domains.length; k++) {
    input.onProgress?.({ k, elapsedMs: elapsed() });
    solver.push();
    solver.add(Z3.AtMost(bounded, k));
    const res = await check(assumptions);
    if (res === "sat") {
      const model = solver.model();
      const intOf = (e: Arith<"repair">): number => {
        const s = model.eval(e, true).toString().replace(/\s+/g, "");
        return s.startsWith("(-") ? -Number(s.slice(2, -1)) : Number(s);
      };
      const solved = new Map<string, Assignment>();
      const moved: string[] = [];
      for (let i = 0; i < domains.length; i++) {
        const d = domains[i]!;
        const a = proposalById.get(d.fixtureId)!;
        const startMin = intOf(start[i]!);
        const ci = intOf(courtVar[i]!);
        const still = startMin === origStartMin[i]! && ci === origCourtIdx[i]!;
        // A fixture that did not move keeps its ORIGINAL instant to the
        // millisecond. Round-tripping it through minutes would rewrite a board
        // the organiser may already have published.
        const startAt = still ? a.startAt : startMin * MS_PER_MIN;
        solved.set(d.fixtureId, {
          ...a,
          startAt,
          endAt: startAt + d.durationMs,
          court: courts[ci] ?? a.court,
        });
        if (!still) moved.push(d.fixtureId);
      }
      solver.pop();
      // Caller order out, fixtureId order for `moved` — both fixed, so the same
      // input serialises identically twice.
      const assignments = proposal.map((a) => solved.get(a.fixtureId) ?? a);
      const elapsedMs = elapsed();
      if (moved.length === 0) {
        // Step 1 already proved this board DIRTY, so a model in which nothing
        // moves is never a clean board. Two ways to arrive here, and they are
        // not the same event:
        //
        //   * `relaxed` is empty — every family was in play, the model satisfies
        //     all of them, and the verifier rejects the board anyway. The
        //     encoding lost a constraint. Thrown, not returned: `status:
        //     "clean"` here laundered exactly that past both web runners, which
        //     call `repairSchedule` rather than `repairAndVerify`.
        //   * `relaxed` is non-empty — what is left is confined to families that
        //     were dropped (a rest breach nothing can fix, say). Zero moves
        //     genuinely IS the minimum under the blocking rules, and `relaxed`
        //     tells the caller what was given up.
        const zeroMove: RepairResult = {
          status: "repaired",
          assignments,
          moved: [],
          k: 0,
          elapsedMs,
          checks,
          relaxed,
        };
        if (relaxed.length === 0) {
          throw new RepairVerificationError(
            "repair encoding drift: the solver satisfied every family with nothing moved, " +
              `on a board the verifier rejects with ${pre.length} conflict(s)`,
            pre,
            zeroMove,
            "encoding_drift",
          );
        }
        return zeroMove;
      }
      return { status: "repaired", assignments, moved, k: moved.length, elapsedMs, checks, relaxed };
    }
    solver.pop();
    if (res === "budget") return timeout(k);
  }

  // Unreachable while the probe above is sat — every fixture free to move is
  // exactly the probe. Kept so an encoding drift reports rather than falls off
  // the end of the function.
  return { status: "infeasible", families: sortFamilies(coreFamilies()), elapsedMs: elapsed(), checks };
}

function sharesParticipant(a: Assignment, b: Assignment): boolean {
  for (const e of a.entrants) if (b.entrants.includes(e)) return true;
  for (const p of a.people) if (b.people.includes(p)) return true;
  return false;
}

/**
 * Repairs, then re-runs the REAL verifier on the result.
 *
 * A `repaired` result with no relaxed families must be conflict-FREE. One with
 * relaxed families must at least be free of BLOCKING conflicts. Anything else
 * throws: the solver and the verifier disagreeing about what the rules mean is
 * an impossible event, and impossible events that occur should be loud rather
 * than shipped as a board the organiser is then locked out of editing.
 */
export async function repairAndVerify(input: RepairInput): Promise<RepairResult> {
  const result = await repairSchedule(input);
  if (result.status !== "repaired" && result.status !== "clean") return result;
  const conflicts = validateAssignments(
    result.assignments,
    input.config,
    input.existing ?? [],
    input.dependencies ?? [],
  );
  const offending =
    result.relaxed.length === 0 ? conflicts : conflicts.filter(isBlockingConflict);
  if (offending.length > 0) {
    throw new RepairVerificationError(
      `repair produced a schedule its own verifier rejects: ${offending.length} conflict(s)`,
      offending,
      result,
    );
  }
  return result;
}


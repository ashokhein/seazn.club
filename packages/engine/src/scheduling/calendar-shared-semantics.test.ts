// The solver may not hold an opinion of its own about what a rule means (#401).
// These tests pin the exported semantics to what `validateAssignments` actually
// enforces, so a future divergence fails here instead of silently producing a
// "repaired" board the verifier rejects.
import { describe, expect, it } from "vitest";
import {
  effectiveHard,
  intervalsOverlap,
  pairRestMinutes,
  slotFixtures,
  startWindowFor,
  validateAssignments,
  type Assignment,
  type VerifyConfig,
} from "./calendar.ts";
import { assign, at, BADMINTON, BASE_CONFIG, SOLO } from "./payload-fixtures.ts";

const MIN = 60_000;

describe("exported rule semantics", () => {
  it("effectiveHard merges both homes, compiled first", () => {
    const compiled = [{ type: "not_before", time: "09:00", scope: { kind: "competition" } }] as const;
    const stored = [{ type: "not_after", time: "21:00", scope: { kind: "competition" } }] as const;
    expect(effectiveHard({ hard: compiled, constraints: undefined })).toEqual(compiled);
    expect(effectiveHard({ hard: undefined, constraints: { hard: stored } as never })).toEqual(stored);
    expect(effectiveHard({ hard: compiled, constraints: { hard: stored } as never })).toEqual([
      ...compiled,
      ...stored,
    ]);
  });

  it("pairRestMinutes is the number validateAssignments enforces", () => {
    const config: VerifyConfig = { ...BASE_CONFIG, perEntrantMinRest: 45 };
    const [a, b] = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r1-i0", "2026-08-10T09:40:00Z", "C2"],
    ]);
    const rest = pairRestMinutes(config, a!, b!);
    expect(rest).toBe(45);
    // One minute short of the exported number must be a `rest` conflict; the
    // number itself must be clean. Anything else means two definitions exist.
    const short = [a!, { ...b!, startAt: a!.endAt + (rest - 1) * MIN, endAt: a!.endAt + (rest + 39) * MIN }];
    const exact = [a!, { ...b!, startAt: a!.endAt + rest * MIN, endAt: a!.endAt + (rest + 40) * MIN }];
    expect(validateAssignments(short, config).some((c) => c.reason === "rest")).toBe(true);
    expect(validateAssignments(exact, config).some((c) => c.reason === "rest")).toBe(false);
  });

  it("startWindowFor returns the bounds the verifier compares against", () => {
    const notBefore = at("2026-08-10T10:00:00Z");
    const config: VerifyConfig = {
      ...BASE_CONFIG,
      constraints: {
        startWindows: [{ target: { kind: "division", id: "d1" }, notBefore }],
        noBackToBack: false,
        fieldFairness: "off",
        parallelism: "mixed",
      } as never,
    };
    const a: Assignment = {
      fixtureId: "f1",
      court: "C1",
      startAt: notBefore - MIN,
      endAt: notBefore + 39 * MIN,
      entrants: [],
      people: [],
      divisionId: "d1",
    };
    expect(startWindowFor(config, a).notBefore).toBe(notBefore);
    expect(validateAssignments([a], config).some((c) => c.reason === "start_window")).toBe(true);
  });

  it("intervalsOverlap is half-open — touching is not overlapping", () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 11, 10, 20)).toBe(true);
  });

  // A pair spanning `assignments` and `existing` is judged ONE-directionally:
  // the outer loop is `for (const a of assignments)`, so only the MOVABLE side's
  // pool/division is ever the first argument. A solver that asserts the max
  // against an immovable over-constrains and reports a spurious infeasible.
  it("a movable-vs-existing pair owes only the movable side's direction", () => {
    const config: VerifyConfig = {
      ...BASE_CONFIG,
      constraints: {
        // The two directions genuinely disagree: `effectiveRestMinutes` reads
        // the FIRST argument's pool, and the two fixtures sit in different ones.
        restByGroup: { "pool-lax": 30, "pool-strict": 90 },
        noBackToBack: false,
        fieldFairness: "off",
        parallelism: "mixed",
      } as never,
    };
    const t0 = at("2026-08-10T09:00:00Z");
    const immovable: Assignment = {
      fixtureId: "x1",
      court: "C2",
      startAt: t0,
      endAt: t0 + 40 * MIN,
      entrants: ["e1"],
      people: [],
      poolId: "pool-strict",
    };
    const movable: Assignment = {
      fixtureId: "m1",
      court: "C1",
      // 45 minutes after the immovable ends: clears 30, breaches 90.
      startAt: t0 + 85 * MIN,
      endAt: t0 + 125 * MIN,
      entrants: ["e1"],
      people: [],
      poolId: "pool-lax",
    };
    expect(pairRestMinutes(config, movable, immovable)).toBe(30);
    expect(pairRestMinutes(config, immovable, movable)).toBe(90);
    // One-directional against `existing` — the 90 is never asked for.
    expect(validateAssignments([movable], config, [immovable]).some((c) => c.reason === "rest")).toBe(false);
    // Both movable: the verifier evaluates the pair once per assignment, so the
    // strict direction is reached and the max binds.
    expect(validateAssignments([movable, immovable], config).some((c) => c.reason === "rest")).toBe(true);
  });

  // #446 — the placer's OWN OUTPUT is the input the verifier is handed next
  // (Auto-schedule places a board, the organiser drags one card, the board is
  // re-verified). `slotFixtures` resolves `restByGroup` and `startWindows` off
  // `SchedulableFixture.poolId`; `validateAssignments` resolves the same two
  // rules off `Assignment.poolId`. If `commit()` drops the field on the way out,
  // the rule holds while the placer is looking and evaporates the instant
  // anything re-reads the result — which is the fork this whole file exists for.
  //
  // Asserted on a MOVED card, not on the placer's clean board: a lost group id
  // can only make the verifier LAXER, so a legal board round-trips clean either
  // way and proves nothing.
  describe("a placer placement re-read by the verifier (#446)", () => {
    const t0 = at("2026-08-10T09:00:00Z");
    const poolConfig = {
      ...BASE_CONFIG,
      startAt: t0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 30,
      constraints: {
        restByGroup: { "pool-a": 180 },
        startWindows: [{ target: { kind: "pool", id: "pool-a" }, notAfter: t0 + 600 * MIN }],
        noBackToBack: false,
        fieldFairness: "off",
        parallelism: "mixed",
      } as never,
    };
    const place = () =>
      slotFixtures({
        fixtures: [
          { id: "pa-1", roundNo: 0, home: "e1", away: "e2", poolId: "pool-a", divisionId: "d1" },
          { id: "pa-2", roundNo: 1, home: "e1", away: "e3", poolId: "pool-a", divisionId: "d1" },
        ],
        config: poolConfig,
      });

    it("the placer honours the pool rest and the verifier agrees on the same board", () => {
      const { assignments, conflicts } = place();
      expect(conflicts).toEqual([]);
      expect(assignments).toHaveLength(2);
      // The placer really did apply the 180, not the 30 default.
      expect(assignments[1]!.startAt - assignments[0]!.endAt).toBe(180 * MIN);
      expect(validateAssignments(assignments, poolConfig)).toEqual([]);
    });

    it("a placed pool card dragged inside the pool rest is a rest conflict", () => {
      const [first, second] = place().assignments;
      // 40 minutes after the first ends: clears the 30-minute default, breaches
      // the 180 the placer itself just enforced. Only `startAt`/`endAt` change —
      // everything else is the object the placer emitted.
      const dragged: Assignment = {
        ...second!,
        startAt: first!.endAt + 40 * MIN,
        endAt: first!.endAt + 80 * MIN,
      };
      const conflicts = validateAssignments([dragged], poolConfig, [first!]);
      expect(conflicts.map((c) => c.reason)).toContain("rest");
    });

    it("a placed pool card dragged past the pool start window is a start_window conflict", () => {
      const [, second] = place().assignments;
      const late = t0 + 700 * MIN; // beyond notAfter = t0 + 600
      const dragged: Assignment = { ...second!, startAt: late, endAt: late + 40 * MIN };
      expect(startWindowFor(poolConfig, dragged).notAfter).toBe(t0 + 600 * MIN);
      const conflicts = validateAssignments([dragged], poolConfig);
      expect(conflicts.map((c) => c.reason)).toContain("start_window");
    });
  });

  // #447 — a DURABLE `min_rest_minutes` rule is the one rest source the placer
  // could not see. `validateInstructionRules` skips `rest_scope: "per_person"`
  // on purpose (it is folded into the rest bound so one short gap is reported
  // once as `rest`, not twice), and that fold lived only in
  // `pairRestMinutesWith`. `slotFixtures` resolved rest through
  // `effectiveRestMinutes`, which reads the settings/constraints family and
  // never `hard` — so Auto proposed a board the apply gate warned about, and
  // re-running Auto could not fix it because the placer did not know the rule
  // existed. Both sides now read `hardRestMinutesFor`.
  describe("a durable per_person min_rest across the placer/verifier seam (#447)", () => {
    const t0 = at("2026-08-10T09:00:00Z");
    const durable = (hard: unknown[]) => ({
      ...BASE_CONFIG,
      startAt: t0,
      courts: ["C1", "C2"],
      // A 30-minute floor the rule must RAISE — combining by Math.max, never
      // replacing. Two courts, so nothing but the rest bound can space the pair.
      perEntrantMinRest: 30,
      constraints: {
        hard,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off",
        parallelism: "mixed",
        crossPersonClash: "warn",
      } as never,
    });
    // The issue's own example, scope by scope. `entrant` is the one that proves
    // the placer maps `home`/`away` onto the `entrants` the scope switch reads.
    const COMPETITION = {
      type: "min_rest_minutes",
      minutes: 120,
      rest_scope: "per_person",
      scope: { kind: "competition" },
    };
    const ENTRANT = { ...COMPETITION, scope: { kind: "entrant", entrantId: "e1" } };
    // The `division` scope is the one that exercises the `f?.divisionId ?? a.divisionId`
    // fallback `ScopeRow` exists for: `place` passes no `ruleFixtures`, so `f` is
    // undefined and the scope switch must read the id off the ROW. If a
    // `SchedulableFixture` ever stopped carrying `divisionId`, only this case fails.
    const DIVISION = { ...COMPETITION, scope: { kind: "division", divisionId: "d1" } };
    // Sharing e1 is what makes them a rest pair at all.
    const fixtures = [
      { id: "r-1", roundNo: 0, home: "e1", away: "e2", divisionId: "d1" },
      { id: "r-2", roundNo: 1, home: "e1", away: "e3", divisionId: "d1" },
    ];
    const place = (config: ReturnType<typeof durable>) => slotFixtures({ fixtures, config });

    it.each([
      ["competition-scoped", COMPETITION],
      ["entrant-scoped", ENTRANT],
      ["division-scoped", DIVISION],
    ])("the placer packs to the same number the verifier enforces (%s)", (_label, rule) => {
      const config = durable([rule]);
      const { assignments, conflicts } = place(config);
      expect(conflicts).toEqual([]);
      expect(assignments).toHaveLength(2);
      // THE ASSERTION THAT MATTERS: one number, asked of both sides.
      const verifierBound = pairRestMinutes(config, assignments[0]!, assignments[1]!);
      expect(verifierBound).toBe(120);
      expect(assignments[1]!.startAt - assignments[0]!.endAt).toBe(verifierBound * MIN);
      // And the placer's own output round-trips clean through the verifier —
      // before this fix it came back with a `rest` conflict the placer could
      // never resolve, because re-running it proposed the same board again.
      expect(validateAssignments(assignments, config as VerifyConfig)).toEqual([]);
    });

    it("raises the stored floor rather than replacing it", () => {
      // Guard the guard: without the rule the placer packs at the 30-minute
      // setting, so the 120 above is the rule doing the work and not the
      // fixture's own spacing. A rule BELOW the floor may not lower it.
      expect(place(durable([])).assignments[1]!.startAt - place(durable([])).assignments[0]!.endAt).toBe(30 * MIN);
      const lax = durable([{ ...COMPETITION, minutes: 10 }]);
      expect(place(lax).assignments[1]!.startAt - place(lax).assignments[0]!.endAt).toBe(30 * MIN);
    });

    it("still reports the board a placer that ignored the rule would have built", () => {
      // The pre-fix output, pinned: the two numbers genuinely disagree, so a
      // placer that skips `hard` hands the verifier a board it rejects. Without
      // this, a `hardRestMinutesFor` that always returned 0 would satisfy the
      // round-trip assertion above by making both sides equally blind.
      const config = durable([COMPETITION]);
      const [first] = place(config).assignments;
      const packedAtTheFloor: Assignment[] = [
        first!,
        {
          fixtureId: "r-2",
          court: "C1",
          startAt: first!.endAt + 30 * MIN,
          endAt: first!.endAt + 70 * MIN,
          entrants: ["e1", "e3"],
          people: [],
          divisionId: "d1",
        },
      ];
      expect(
        validateAssignments(packedAtTheFloor, config as VerifyConfig).map((c) => c.reason),
      ).toContain("rest");
    });

    // #459, owner ruling 2026-08-04: a pool-keyed `restByGroup` entry RAISES the
    // floor, it does not override its division. Resolved with `??` before, which
    // made the more specific key win — and made an explicit `0` erase the
    // division rule outright, because `0 ?? x` is `0`.
    describe("restByGroup resolves pool and division by max, not precedence (#459)", () => {
      const grouped = (restByGroup: Record<string, number>) => ({
        ...BASE_CONFIG,
        startAt: t0,
        courts: ["C1", "C2"],
        perEntrantMinRest: 30,
        constraints: {
          restByGroup,
          noBackToBack: false,
          startWindows: [],
          fieldFairness: "off",
          parallelism: "mixed",
          crossPersonClash: "warn",
        } as never,
      });
      // Both fixtures sit in pool-a of d1, so BOTH keys match the same pair.
      const pooled = [
        { id: "g-1", roundNo: 0, home: "e1", away: "e2", divisionId: "d1", poolId: "pool-a" },
        { id: "g-2", roundNo: 1, home: "e1", away: "e3", divisionId: "d1", poolId: "pool-a" },
      ];
      const gap = (config: ReturnType<typeof grouped>) => {
        const { assignments } = slotFixtures({ fixtures: pooled, config });
        expect(assignments).toHaveLength(2);
        return assignments[1]!.startAt - assignments[0]!.endAt;
      };

      it.each([
        ["a laxer pool entry does not lower the division floor", { d1: 180, "pool-a": 45 }, 180],
        ["a stricter pool entry raises it", { d1: 60, "pool-a": 150 }, 150],
        // The `??` case: `0` is not nullish, so it USED to win outright and
        // erase the 180. Under max it contributes nothing, as an explicit
        // "no extra rest for this pool" should.
        ["an explicit pool zero adds nothing rather than erasing the division rule", { d1: 180, "pool-a": 0 }, 180],
      ])("%s", (_label, restByGroup, expected) => {
        const config = grouped(restByGroup);
        expect(gap(config)).toBe(expected * MIN);
        // Placer and verifier must agree — this file exists to fail when they fork.
        const { assignments } = slotFixtures({ fixtures: pooled, config });
        expect(pairRestMinutes(config as VerifyConfig, assignments[0]!, assignments[1]!)).toBe(expected);
        expect(validateAssignments(assignments, config as VerifyConfig)).toEqual([]);
      });
    });
  });

  // REGRESSION TRIPWIRE, NOT A BENCHMARK. `pairRestMinutes` is called from an
  // O(n²) loop; deriving `effectiveHard` + the ruleFixtures Map INSIDE it made
  // the per-config work quadratic too. The threshold is deliberately far above
  // any honest machine-to-machine spread — it exists to fail loudly on that
  // shape, not to police milliseconds.
  //
  // Sizing: on the dev machine this board measured 2967 ms with the derivation
  // inside and ~30 ms with it hoisted. 400 rather than 300 because 300 landed
  // at 1437 ms — under the threshold, i.e. a tripwire that never trips.
  it("validateAssignments stays linear-ish in per-config work on a shared-person board", () => {
    const n = 400;
    const t0 = at("2026-08-10T08:00:00Z");
    const assignments: Assignment[] = [];
    const ruleFixtures = [];
    for (let i = 0; i < n; i++) {
      const startAt = t0 + i * 120 * MIN; // far apart: the rest branch, never overlap
      assignments.push({
        fixtureId: `f${i}`,
        court: `C${i}`,
        startAt,
        endAt: startAt + 40 * MIN,
        entrants: [`e${i}`], // distinct entrants — only the shared PERSON pairs them
        people: ["p-shared"],
        divisionId: "d1",
      });
      ruleFixtures.push({ id: `f${i}`, extKey: `f${i}`, divisionId: "d1", winnerTo: null });
    }
    const config: VerifyConfig = { ...BASE_CONFIG, tz: "UTC", ruleFixtures };
    // `performance.now()` and not `Date.now()`: the boundary gate bans the
    // latter engine-wide (ambient time makes engine output non-reproducible),
    // and a monotonic clock is the right instrument for an elapsed span anyway.
    // Nothing here feeds engine output — the reading is the assertion.
    const started = performance.now();
    validateAssignments(assignments, config);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
  });
});

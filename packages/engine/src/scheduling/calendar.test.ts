// Calendar slotting — spec 05 §2.6, doc 06 §4.3, doc 12.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";

const MIN = 60_000;
const baseConfig = (over: Partial<SlotConfig> = {}): SlotConfig => ({
  startAt: 0,
  matchMinutes: 30,
  gapMinutes: 5,
  courts: ["C1"],
  perEntrantMinRest: 0,
  ...over,
});

describe("slotFixtures — greedy placement (spec 05 §2.6)", () => {
  it("packs one court sequentially with the configured gap", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
      { id: "f3", roundNo: 1, home: "E", away: "F" },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig() });
    expect(conflicts).toHaveLength(0);
    const times = assignments.map((a) => a.startAt).sort((x, y) => x - y);
    // 30-min matches + 5-min gap ⇒ starts at 0, 35, 70 minutes.
    expect(times).toEqual([0, 35 * MIN, 70 * MIN]);
  });

  it("spreads across courts before stacking", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
    ];
    const { assignments } = slotFixtures({ fixtures, config: baseConfig({ courts: ["C1", "C2"] }) });
    // Both can start at 0 on different courts.
    expect(new Set(assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    expect(assignments.every((a) => a.startAt === 0)).toBe(true);
  });

  it("honours per-entrant rest between an entrant's matches", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 2, home: "A", away: "C" }, // A plays again
    ];
    const { assignments } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1", "C2"], perEntrantMinRest: 60 }),
    });
    const f1 = assignments.find((a) => a.fixtureId === "f1") as Assignment;
    const f2 = assignments.find((a) => a.fixtureId === "f2") as Assignment;
    expect(f2.startAt - f1.endAt).toBeGreaterThanOrEqual(60 * MIN);
  });

  it("never schedules inside a blackout window", () => {
    const fixtures: SchedulableFixture[] = [{ id: "f1", roundNo: 1, home: "A", away: "B" }];
    const { assignments } = slotFixtures({
      fixtures,
      config: baseConfig({ blackouts: [{ from: 0, to: 45 * MIN }] }),
    });
    expect((assignments[0] as Assignment).startAt).toBeGreaterThanOrEqual(45 * MIN);
  });

  it("avoids court+time already taken by a sibling division (doc 06 §4.3)", () => {
    const existing: Assignment[] = [
      { fixtureId: "sib", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["X"], people: [] },
    ];
    const fixtures: SchedulableFixture[] = [{ id: "f1", roundNo: 1, home: "A", away: "B" }];
    const { assignments } = slotFixtures({ fixtures, config: baseConfig(), existing });
    // C1 is busy 0–30 (+5 gap) ⇒ our fixture starts at 35.
    expect((assignments[0] as Assignment).startAt).toBe(35 * MIN);
  });

  it("warns (does not block) on a per-person overlap across divisions", () => {
    const existing: Assignment[] = [
      { fixtureId: "sib", court: "C9", startAt: 0, endAt: 30 * MIN, entrants: ["X"], people: ["kid1"] },
    ];
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B", people: ["kid1"] },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1"] }),
      existing,
    });
    // Placed at 0 on a free court, but kid1 also plays sib at 0 → warn.
    expect(assignments).toHaveLength(1);
    expect(conflicts.some((c) => c.reason === "person_overlap")).toBe(true);
  });

  it("honours a locked slot and reports a court clash rather than moving it", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "lockA", roundNo: 1, home: "A", away: "B", locked: { court: "C1", startAt: 100 * MIN } },
      { id: "lockB", roundNo: 1, home: "C", away: "D", locked: { court: "C1", startAt: 100 * MIN } },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig() });
    expect(assignments.map((a) => a.startAt)).toEqual([100 * MIN, 100 * MIN]); // both kept as pinned
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
  });

  it("reports no_slot instead of silently dropping a constraint", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
    ];
    // One court, horizon shorter than the second match would need.
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ horizonMinutes: 10 }),
    });
    expect(assignments).toHaveLength(1);
    expect(conflicts).toEqual([{ fixtureId: "f2", reason: "no_slot", detail: expect.any(String) }]);
  });
});

describe("slotFixtures — session windows (doc 12 §2, PROMPT-17)", () => {
  it("schedules only inside session windows", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
      { id: "f3", roundNo: 2, home: "A", away: "C" },
    ];
    const windows = [
      { from: 10 * MIN, to: 45 * MIN }, // fits exactly one 30-min match
      { from: 120 * MIN, to: 300 * MIN },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ sessionWindows: windows }),
    });
    expect(conflicts).toHaveLength(0);
    for (const a of assignments) {
      expect(windows.some((w) => a.startAt >= w.from && a.endAt <= w.to)).toBe(true);
    }
  });

  it("reports a locked slot outside every session window as a blackout", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "pin", roundNo: 1, home: "A", away: "B", locked: { court: "C1", startAt: 50 * MIN } },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ sessionWindows: [{ from: 0, to: 45 * MIN }] }),
    });
    expect(assignments).toHaveLength(1); // pin honoured, not moved
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "pin", reason: "blackout" }),
    ]);
  });
});

describe("validateAssignments — board conflict report (doc 12 §2/§4)", () => {
  it("flags a court double-booking", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C1", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["B"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
  });

  it("flags an entrant playing two overlapping matches", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C2", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "person_overlap")).toBe(true);
  });

  it("flags a rest violation between an entrant's matches", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C2", startAt: 40 * MIN, endAt: 70 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 60, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "rest")).toBe(true);
  });

  it("flags an assignment outside every session window", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 50 * MIN, endAt: 80 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, {
      perEntrantMinRest: 0,
      gapMinutes: 0,
      sessionWindows: [{ from: 0, to: 45 * MIN }],
    });
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "x", reason: "blackout", detail: "outside session windows" }),
    ]);
  });

  it("flags a fixture scheduled before its feeder ends; direct feeds are marked", () => {
    const a: Assignment[] = [
      { fixtureId: "semi", court: "C1", startAt: 60 * MIN, endAt: 90 * MIN, entrants: [], people: [] },
      { fixtureId: "final", court: "C2", startAt: 0, endAt: 30 * MIN, entrants: [], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 }, [], [
      { fixtureId: "final", dependsOn: "semi", direct: true },
    ]);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "final", reason: "order", direct: true }),
    ]);
  });

  it("order check ignores dependencies whose feeder is not on the board", () => {
    const a: Assignment[] = [
      { fixtureId: "final", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: [], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 }, [], [
      { fixtureId: "final", dependsOn: "semi", direct: true },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("finds every seeded conflict class in one report (PROMPT-17 acceptance)", () => {
    // One board seeding all five classes: court, rest, blackout (window +
    // session), person_overlap, order.
    const a: Assignment[] = [
      { fixtureId: "c1", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "c2", court: "C1", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["B"], people: [] }, // court clash
      { fixtureId: "r1", court: "C2", startAt: 35 * MIN, endAt: 65 * MIN, entrants: ["A"], people: [] }, // A rest < 60
      { fixtureId: "b1", court: "C3", startAt: 200 * MIN, endAt: 230 * MIN, entrants: ["C"], people: [] }, // blackout
      { fixtureId: "p1", court: "C4", startAt: 0, endAt: 30 * MIN, entrants: ["D"], people: ["kid"] },
      { fixtureId: "p2", court: "C5", startAt: 0, endAt: 30 * MIN, entrants: ["E"], people: ["kid"] }, // person overlap
      { fixtureId: "o1", court: "C6", startAt: 500 * MIN, endAt: 530 * MIN, entrants: [], people: [] },
      { fixtureId: "o2", court: "C7", startAt: 400 * MIN, endAt: 430 * MIN, entrants: [], people: [] }, // before feeder o1
    ];
    const conflicts = validateAssignments(
      a,
      { perEntrantMinRest: 60, gapMinutes: 0, blackouts: [{ from: 195 * MIN, to: 240 * MIN }] },
      [],
      [{ fixtureId: "o2", dependsOn: "o1", direct: true }],
    );
    const reasons = new Set(conflicts.map((c) => c.reason));
    expect(reasons).toEqual(new Set(["court", "rest", "blackout", "person_overlap", "order"]));
  });
});

// ---------------------------------------------------------------------------
// Properties — spec 05 §2.6 / §6
// ---------------------------------------------------------------------------

const fixtureArb = fc.array(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    roundNo: fc.integer({ min: 1, max: 5 }),
    home: fc.constantFrom("A", "B", "C", "D", "E", "F"),
    away: fc.constantFrom("A", "B", "C", "D", "E", "F"),
  }),
  { minLength: 1, maxLength: 20 },
);

describe("slotFixtures — invariants (spec 05 §6)", () => {
  it("no two assignments clash on a court (respecting the gap)", () => {
    fc.assert(
      fc.property(fixtureArb, fc.integer({ min: 1, max: 3 }), (raw, courtCount) => {
        const fixtures = dedupeIds(raw);
        const courts = Array.from({ length: courtCount }, (_, i) => `C${i}`);
        const { assignments } = slotFixtures({ fixtures, config: baseConfig({ courts, gapMinutes: 5 }) });
        for (let i = 0; i < assignments.length; i++) {
          for (let j = i + 1; j < assignments.length; j++) {
            const a = assignments[i] as Assignment;
            const b = assignments[j] as Assignment;
            if (a.court !== b.court) continue;
            const clash = a.startAt < b.endAt + 5 * MIN && b.startAt < a.endAt + 5 * MIN;
            expect(clash).toBe(false);
          }
        }
      }),
    );
  });

  it("every entrant's consecutive matches respect rest", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw).filter((f) => f.home !== f.away);
        const rest = 45;
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1", "C2"], perEntrantMinRest: rest }),
        });
        const byEntrant = new Map<string, Assignment[]>();
        for (const a of assignments) {
          for (const e of a.entrants) (byEntrant.get(e) ?? byEntrant.set(e, []).get(e)!).push(a);
        }
        for (const list of byEntrant.values()) {
          list.sort((x, y) => x.startAt - y.startAt);
          for (let i = 1; i < list.length; i++) {
            expect((list[i] as Assignment).startAt - (list[i - 1] as Assignment).endAt).toBeGreaterThanOrEqual(
              rest * MIN,
            );
          }
        }
      }),
    );
  });

  it("no assignment lands in a blackout window", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const blackouts = [{ from: 20 * MIN, to: 80 * MIN }];
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1"], blackouts }),
        });
        for (const a of assignments) {
          expect(a.startAt < 80 * MIN && 20 * MIN < a.endAt).toBe(false);
        }
      }),
    );
  });

  it("never silently drops a fixture — each is assigned or conflicted", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig({ courts: ["C0", "C1"] }) });
        const assigned = new Set(assignments.map((a) => a.fixtureId));
        const noSlot = new Set(conflicts.filter((c) => c.reason === "no_slot").map((c) => c.fixtureId));
        for (const f of fixtures) expect(assigned.has(f.id) || noSlot.has(f.id)).toBe(true);
      }),
    );
  });

  it("re-run with all outputs locked = zero moves (PROMPT-17 acceptance)", () => {
    fc.assert(
      fc.property(fixtureArb, fc.integer({ min: 1, max: 3 }), (raw, courtCount) => {
        const fixtures = dedupeIds(raw).filter((f) => f.home !== f.away);
        const courts = Array.from({ length: courtCount }, (_, i) => `C${i}`);
        const cfg = baseConfig({ courts, perEntrantMinRest: 30 });
        const first = slotFixtures({ fixtures, config: cfg });
        const bySlot = new Map(first.assignments.map((a) => [a.fixtureId, a]));
        // Lock every placed fixture at its own output slot and re-run.
        const locked = fixtures
          .filter((f) => bySlot.has(f.id))
          .map((f) => {
            const a = bySlot.get(f.id) as Assignment;
            return { ...f, locked: { court: a.court, startAt: a.startAt } };
          });
        const second = slotFixtures({ fixtures: locked, config: cfg });
        const secondBySlot = new Map(second.assignments.map((a) => [a.fixtureId, a]));
        expect(secondBySlot.size).toBe(bySlot.size);
        for (const [id, a] of bySlot) {
          const b = secondBySlot.get(id) as Assignment;
          expect({ court: b.court, startAt: b.startAt, endAt: b.endAt }).toEqual({
            court: a.court,
            startAt: a.startAt,
            endAt: a.endAt,
          });
        }
        // A mutually consistent board re-locked must not report court clashes.
        expect(second.conflicts.filter((c) => c.reason === "court")).toHaveLength(0);
      }),
    );
  });

  it("every assignment sits fully inside a session window when windows are set", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const windows = [
          { from: 0, to: 90 * MIN },
          { from: 240 * MIN, to: 480 * MIN },
        ];
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1"], sessionWindows: windows }),
        });
        for (const a of assignments) {
          expect(windows.some((w) => a.startAt >= w.from && a.endAt <= w.to)).toBe(true);
        }
      }),
    );
  });

  it("is idempotent — identical inputs yield identical output", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const cfg = baseConfig({ courts: ["C0", "C1"], perEntrantMinRest: 30 });
        expect(slotFixtures({ fixtures, config: cfg })).toEqual(slotFixtures({ fixtures, config: cfg }));
      }),
    );
  });
});

// fast-check may repeat ids; the slotter keys on id, so keep them unique per case.
function dedupeIds(raw: SchedulableFixture[]): SchedulableFixture[] {
  return raw.map((f, i) => ({ ...f, id: `${f.id}-${i}` }));
}

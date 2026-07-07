// Constraints v2 goldens + properties (Jul3/04, PROMPT-24 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { slotFixtures, type Assignment, type SchedulableFixture, type SlotConfig } from "./calendar.ts";
import { SchedulingConstraints } from "./constraints.ts";
import { scheduleReport, shiftSchedule } from "./report.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 18, 8, 0, 0);

function config(partial: Partial<SlotConfig> = {}): SlotConfig {
  return {
    startAt: T0,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1", "C2"],
    perEntrantMinRest: 0,
    ...partial,
  };
}

const c = (p: Partial<SchedulingConstraints>) => SchedulingConstraints.parse(p);

describe("constraints v2 goldens (Jul3/04)", () => {
  it("a player entered in two divisions is never double-booked (crossPersonClash=hard)", () => {
    // one shared person across two divisions' fixtures
    const fixtures: SchedulableFixture[] = [
      { id: "d1f1", home: "a", away: "b", people: ["sam"], divisionId: "d1" },
      { id: "d2f1", home: "x", away: "y", people: ["sam"], divisionId: "d2" },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: config({ courts: ["C1", "C2"], constraints: c({ crossPersonClash: "hard" }) }),
    });
    expect(conflicts).toEqual([]);
    const [a, b] = assignments;
    expect(a!.startAt < b!.endAt && b!.startAt < a!.endAt).toBe(false); // no overlap
  });

  it("a notBefore:09:30 team is never slotted earlier (14 Apr)", () => {
    const nineThirty = T0 + 90 * MIN;
    const fixtures: SchedulableFixture[] = [
      { id: "f1", home: "xy", away: "b" },
      { id: "f2", home: "c", away: "d" },
    ];
    const { assignments } = slotFixtures({
      fixtures,
      config: config({
        courts: ["C1"],
        constraints: c({
          startWindows: [{ target: { kind: "entrant", id: "xy" }, notBefore: nineThirty }],
        }),
      }),
    });
    const f1 = assignments.find((a) => a.fixtureId === "f1")!;
    expect(f1.startAt).toBeGreaterThanOrEqual(nineThirty);
    // the unconstrained fixture still takes the early slot
    const f2 = assignments.find((a) => a.fixtureId === "f2")!;
    expect(f2.startAt).toBe(T0);
  });

  it("infeasible start window reports the binding constraint (Jul3/04 §7)", () => {
    const { assignments, conflicts } = slotFixtures({
      fixtures: [{ id: "f1", home: "a", away: "b" }],
      config: config({
        courts: ["C1"],
        constraints: c({
          startWindows: [
            { target: { kind: "entrant", id: "a" }, notBefore: T0 + 60 * MIN, notAfter: T0 + 30 * MIN },
          ],
        }),
      }),
    });
    expect(assignments).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "f1", reason: "start_window" }),
    ]);
  });

  it("noBackToBack forces at least one slot between an entrant's games (4 Jun)", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", home: "a", away: "b" },
      { id: "f2", home: "a", away: "c" },
    ];
    const { assignments } = slotFixtures({
      fixtures,
      config: config({ courts: ["C1"], constraints: c({ noBackToBack: true }) }),
    });
    const [g1, g2] = [...assignments].sort((x, y) => x.startAt - y.startAt);
    expect(g2!.startAt - g1!.endAt).toBeGreaterThanOrEqual(30 * MIN);
  });

  it("bulk-shift +15m moves all in scope; locked and decided stay (10 Jun)", () => {
    const at = (m: number) => new Date(T0 + m * MIN).toISOString();
    const { moves, skipped } = shiftSchedule(
      [
        { id: "f1", at: at(0), court: "C1", locked: false, decided: false },
        { id: "f2", at: at(30), court: "C1", locked: true, decided: false },
        { id: "f3", at: at(60), court: "C2", locked: false, decided: true },
        { id: "f4", at: null, court: null, locked: false, decided: false },
      ],
      {},
      15,
    );
    expect(moves).toEqual([
      { fixture: "f1", from: { at: at(0), court: "C1" }, to: { at: at(15), court: "C1" } },
    ]);
    expect(skipped).toEqual({ locked: 1, decided: 1 });
  });

  it("scheduleReport surfaces the worst wait (16 Sep)", () => {
    const mk = (id: string, startMin: number, entrants: string[]): Assignment => ({
      fixtureId: id,
      court: "C1",
      startAt: T0 + startMin * MIN,
      endAt: T0 + (startMin + 30) * MIN,
      entrants,
      people: [],
    });
    const report = scheduleReport([
      mk("f1", 0, ["a", "b"]),
      mk("f2", 300, ["a", "c"]), // a waits 270 minutes
      mk("f3", 60, ["b", "c"]),
    ]);
    expect(report.worst[0]).toMatchObject({ entrantId: "a", maxGapMinutes: 270 });
    const a = report.perEntrant.find((r) => r.entrantId === "a")!;
    expect(a.minGapMinutes).toBe(270);
    expect(a.spanMinutes).toBe(300);
  });
});

describe("constraints v2 properties (PROMPT-24)", () => {
  const PEOPLE = ["p1", "p2", "p3"];
  const arbitraryFixtures = fc
    .array(
      fc.record({
        pair: fc.integer({ min: 0, max: 5 }),
        person: fc.option(fc.constantFrom(...PEOPLE), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 24 },
    )
    .map((rows) =>
      rows.map(
        (r, i): SchedulableFixture => ({
          id: `f${i}`,
          home: `e${r.pair}`,
          away: `e${r.pair + 1}`,
          people: r.person ? [r.person] : [],
        }),
      ),
    );

  it("crossPersonClash=hard: no schedule places a person in two overlapping fixtures", () => {
    fc.assert(
      fc.property(arbitraryFixtures, (fixtures) => {
        const { assignments } = slotFixtures({
          fixtures,
          config: config({ constraints: c({ crossPersonClash: "hard" }) }),
        });
        for (const a of assignments) {
          for (const b of assignments) {
            if (a === b) continue;
            if (!a.people.some((p) => b.people.includes(p))) continue;
            expect(a.startAt < b.endAt && b.startAt < a.endAt).toBe(false);
          }
        }
      }),
      { numRuns: 120 },
    );
  });

  it("rest bounds always hold; over-constrained cases yield conflicts, never an invalid slot", () => {
    fc.assert(
      fc.property(
        arbitraryFixtures,
        fc.integer({ min: 0, max: 120 }),
        (fixtures, restMin) => {
          const { assignments, conflicts } = slotFixtures({
            fixtures,
            config: config({
              horizonMinutes: 240, // tight horizon → some instances infeasible
              constraints: c({ restMin }),
            }),
          });
          // every placed same-entrant pair honours the rest bound (no overlap,
          // and end→start gap ≥ restMin)
          for (const a of assignments) {
            for (const b of assignments) {
              if (a === b) continue;
              if (!a.entrants.some((e) => b.entrants.includes(e))) continue;
              expect(a.startAt < b.endAt && b.startAt < a.endAt).toBe(false);
              const gap = a.startAt >= b.endAt ? a.startAt - b.endAt : b.startAt - a.endAt;
              expect(gap).toBeGreaterThanOrEqual(restMin * MIN);
            }
          }
          // best-effort contract: unplaced fixtures are all reported
          expect(assignments.length + conflicts.filter((x) => x.reason === "no_slot" || x.reason === "start_window").length)
            .toBeGreaterThanOrEqual(fixtures.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

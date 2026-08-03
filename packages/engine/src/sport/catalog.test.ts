// Lineup validation against the position catalog — spec 02 §3, PROMPT-03 §1.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { LineupSlot } from "../core/types.ts";
import type { Lineup } from "../core/types.ts";
import { assertLineup, validateLineup, type PositionCatalog } from "./catalog.ts";

// Small football-shaped catalog: exactly one GK, at most two FW, captain
// unique, keeper unique + required (cricket-style, spec 04 §2.7).
const catalog: PositionCatalog = {
  groups: [
    { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
    { key: "DF", name: "Defender" },
    { key: "FW", name: "Forward", max: 2 },
  ],
  roles: [
    { key: "captain", unique: true },
    { key: "keeper", unique: true, required: true },
  ],
  lineup: { size: 3, benchMax: 1 },
};

function slot(overrides: Partial<LineupSlot> & { personId: string }): LineupSlot {
  return { slot: "starting", orderNo: 1, ...overrides };
}

function lineup(...slots: LineupSlot[]): Lineup {
  return { entrantId: "H", slots: slots.map((s, i) => ({ ...s, orderNo: i + 1 })) };
}

const valid = lineup(
  slot({ personId: "p1", positionKey: "GK", roles: ["keeper"] }),
  slot({ personId: "p2", positionKey: "DF", roles: ["captain"] }),
  slot({ personId: "p3", positionKey: "FW" }),
);

describe("validateLineup", () => {
  it("accepts a valid lineup", () => {
    expect(validateLineup(catalog, valid)).toEqual([]);
  });

  it("accepts a bench within benchMax", () => {
    const withBench = lineup(...valid.slots, slot({ personId: "p4", slot: "bench" }));
    expect(validateLineup(catalog, withBench)).toEqual([]);
  });

  it("reports a wrong starting size", () => {
    const short = lineup(valid.slots[0] as LineupSlot, valid.slots[1] as LineupSlot);
    expect(validateLineup(catalog, short)).toContainEqual({
      kind: "starting_size",
      expected: 3,
      actual: 2,
    });
  });

  it("reports bench overflow", () => {
    const overfull = lineup(
      ...valid.slots,
      slot({ personId: "p4", slot: "bench" }),
      slot({ personId: "p5", slot: "bench" }),
    );
    expect(validateLineup(catalog, overfull)).toContainEqual({
      kind: "bench_size",
      max: 1,
      actual: 2,
    });
  });

  it("reports duplicate persons", () => {
    const doubled = lineup(
      slot({ personId: "p1", positionKey: "GK", roles: ["keeper"] }),
      slot({ personId: "p1", positionKey: "DF" }),
      slot({ personId: "p3", positionKey: "DF" }),
    );
    expect(validateLineup(catalog, doubled)).toContainEqual({
      kind: "duplicate_person",
      personId: "p1",
    });
  });

  it("reports unknown position keys", () => {
    const unknown = lineup(
      slot({ personId: "p1", positionKey: "GK", roles: ["keeper"] }),
      slot({ personId: "p2", positionKey: "XX" }),
      slot({ personId: "p3", positionKey: "DF" }),
    );
    expect(validateLineup(catalog, unknown)).toContainEqual({
      kind: "unknown_position",
      positionKey: "XX",
      personId: "p2",
    });
  });

  it("reports group min and max violations on the starting lineup", () => {
    const noKeeperTooManyForwards = lineup(
      slot({ personId: "p1", positionKey: "FW", roles: ["keeper"] }),
      slot({ personId: "p2", positionKey: "FW" }),
      slot({ personId: "p3", positionKey: "FW" }),
    );
    const issues = validateLineup(catalog, noKeeperTooManyForwards);
    expect(issues).toContainEqual({ kind: "group_min", groupKey: "GK", min: 1, actual: 0 });
    expect(issues).toContainEqual({ kind: "group_max", groupKey: "FW", max: 2, actual: 3 });
  });

  it("ignores group bounds for bench slots", () => {
    const benchGk = lineup(...valid.slots, slot({ personId: "p4", positionKey: "GK", slot: "bench" }));
    expect(validateLineup(catalog, benchGk)).toEqual([]);
  });

  it("reports duplicate unique roles across starting and bench", () => {
    const twoCaptains = lineup(
      slot({ personId: "p1", positionKey: "GK", roles: ["keeper", "captain"] }),
      slot({ personId: "p2", positionKey: "DF" }),
      slot({ personId: "p3", positionKey: "DF", roles: ["captain"] }),
    );
    expect(validateLineup(catalog, twoCaptains)).toContainEqual({
      kind: "role_duplicate",
      roleKey: "captain",
      personIds: ["p1", "p3"],
    });
  });

  it("reports a missing required role — a benched keeper does not count", () => {
    const benchedKeeper = lineup(
      slot({ personId: "p1", positionKey: "GK" }),
      slot({ personId: "p2", positionKey: "DF" }),
      slot({ personId: "p3", positionKey: "DF" }),
      slot({ personId: "p4", slot: "bench", roles: ["keeper"] }),
    );
    expect(validateLineup(catalog, benchedKeeper)).toContainEqual({
      kind: "role_missing",
      roleKey: "keeper",
    });
  });

  it("reports unknown role keys", () => {
    const unknownRole = lineup(
      slot({ personId: "p1", positionKey: "GK", roles: ["keeper"] }),
      slot({ personId: "p2", positionKey: "DF", roles: ["mascot"] }),
      slot({ personId: "p3", positionKey: "DF" }),
    );
    expect(validateLineup(catalog, unknownRole)).toContainEqual({
      kind: "role_unknown",
      roleKey: "mascot",
      personId: "p2",
    });
  });

  it("works without roles or group bounds", () => {
    const bare: PositionCatalog = { groups: [], lineup: { size: 1 } };
    expect(validateLineup(bare, lineup(slot({ personId: "p1" })))).toEqual([]);
  });
});

describe("assertLineup", () => {
  it("throws LINEUP_INVALID with the issues attached", () => {
    const short = lineup(slot({ personId: "p1", positionKey: "GK", roles: ["keeper"] }));
    try {
      assertLineup(catalog, short);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(EngineError.is(error, "LINEUP_INVALID")).toBe(true);
      expect((error as EngineError).data).toMatchObject({
        entrantId: "H",
        issues: expect.arrayContaining([{ kind: "starting_size", expected: 3, actual: 1 }]),
      });
    }
  });

  it("passes silently on a valid lineup", () => {
    expect(() => assertLineup(catalog, valid)).not.toThrow();
  });
});

// W4 shared-engine item 3 — `entrantModel.team.squadNumbers` advertises squad
// numbers, but a LineupSlot had nowhere to put one, so the number that appears
// on every team sheet and scoresheet had no home in the engine.
describe("squad numbers on a lineup slot (W4)", () => {
  const numbered = lineup(
    slot({ personId: "p1", positionKey: "GK", roles: ["keeper"], squadNumber: 1 }),
    slot({ personId: "p2", positionKey: "DF", roles: ["captain"], squadNumber: 4 }),
    slot({ personId: "p3", positionKey: "FW", squadNumber: 9 }),
  );

  it("survives the LineupSlot schema instead of being stripped", () => {
    const parsed = LineupSlot.parse({
      personId: "p1",
      slot: "starting",
      orderNo: 1,
      squadNumber: 7,
    });
    expect(parsed.squadNumber).toBe(7);
  });

  it("accepts 0 as a squad number but rejects a negative one", () => {
    expect(LineupSlot.safeParse({ personId: "p", slot: "starting", orderNo: 1, squadNumber: 0 })
      .success).toBe(true);
    expect(LineupSlot.safeParse({ personId: "p", slot: "starting", orderNo: 1, squadNumber: -1 })
      .success).toBe(false);
  });

  it("validates a numbered lineup exactly as it validates an unnumbered one", () => {
    expect(validateLineup(catalog, numbered)).toEqual([]);
  });

  it("still validates when the numbers are absent — the field is optional", () => {
    expect(validateLineup(catalog, valid)).toEqual([]);
    expect(valid.slots.every((s) => s.squadNumber === undefined)).toBe(true);
  });

  // W4 review item 7 — the engine had two names for one concept: the roster
  // path advertises the affordance as `entrantModel.team.squadNumbers`
  // (src/sport/entrant-model.ts, pre-W4), while the new lineup field was called
  // `shirtNumber`. One concept, one name: the roster path is the incumbent, so
  // the lineup field follows it. LineupSlot is a plain z.object, so the retired
  // name is STRIPPED rather than rejected — which is exactly why this needs an
  // assertion: a caller still writing `shirtNumber` loses the number silently.
  it("uses the roster path's name for the number, and drops the retired one", () => {
    const parsed = LineupSlot.parse({
      personId: "p1",
      slot: "starting",
      orderNo: 1,
      squadNumber: 7,
    });
    expect(parsed.squadNumber).toBe(7);

    const legacy = LineupSlot.parse({
      personId: "p1",
      slot: "starting",
      orderNo: 1,
      shirtNumber: 7,
    });
    expect(Object.keys(legacy)).not.toContain("shirtNumber");
    expect(Object.keys(legacy)).not.toContain("squadNumber");
  });
});

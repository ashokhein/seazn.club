// W4a (#425) T10 — the walker behind the golden corpus's FIELD-level tripwire.
//
// Every fixture below is a synthetic schema declared right here, so the
// expectations are hand-written against a shape the reader can see rather than
// derived from the function under test (a list asserted against the thing it
// was derived from pins nothing).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import football from "../sports/football/index.ts";
import { fieldPresent, optionalFieldPaths } from "./schema-fields.ts";

describe("optionalFieldPaths", () => {
  it("reports a strictObject's optional keys and none of its required ones", () => {
    const schema = z.strictObject({
      by: z.string(),
      person: z.string().optional(),
      minute: z.number().optional(),
    });
    expect(optionalFieldPaths(schema)).toEqual(["minute", "person"]);
  });

  it("returns nothing for an object with no optional key", () => {
    expect(optionalFieldPaths(z.strictObject({ by: z.string(), scored: z.boolean() }))).toEqual([]);
  });

  it("unions every branch, deduped and sorted", () => {
    const schema = z.union([
      z.strictObject({ by: z.string(), at: z.string().optional() }),
      z.strictObject({ to: z.string(), at: z.string().optional(), reason: z.string().optional() }),
      z.strictObject({ phase: z.literal("HT"), addedMinutes: z.number().optional() }),
    ]);
    expect(optionalFieldPaths(schema)).toEqual(["addedMinutes", "at", "reason"]);
  });

  it("dots a nested object's optional key, and reports an optional parent too", () => {
    const schema = z.strictObject({
      clock: z.strictObject({ base: z.number(), delay: z.number().optional() }).optional(),
      meta: z.strictObject({ kind: z.string(), receiverSide: z.string().optional() }),
    });
    expect(optionalFieldPaths(schema)).toEqual(["clock", "clock.delay", "meta.receiverSide"]);
  });

  it("does NOT report a required leaf inside an optional object", () => {
    // `at: GameTime.optional()` — `period`/`elapsed` are required WHEN PRESENT,
    // so covering `at` is what pins their shape; they are not fields to cover.
    const gameTime = z.strictObject({ period: z.string(), elapsed: z.number() });
    expect(optionalFieldPaths(z.strictObject({ at: gameTime.optional() }))).toEqual(["at"]);
  });

  it("descends into array elements with a [] segment", () => {
    const schema = z.strictObject({
      assists: z.array(z.strictObject({ person: z.string(), secondary: z.boolean().optional() })),
    });
    expect(optionalFieldPaths(schema)).toEqual(["assists[].secondary"]);
  });

  it("descends into a union nested inside a branch", () => {
    const schema = z.strictObject({
      body: z.union([
        z.strictObject({ kind: z.literal("a"), note: z.string().optional() }),
        z.strictObject({ kind: z.literal("b"), tag: z.string().optional() }),
      ]),
    });
    expect(optionalFieldPaths(schema)).toEqual(["body.note", "body.tag"]);
  });

  it("treats a defaulted key as optional — the PAYLOAD may omit it", () => {
    const schema = z.strictObject({ policy: z.string().default("replay"), by: z.string() });
    expect(optionalFieldPaths(schema)).toEqual(["policy"]);
  });

  it("does not treat a nullable-but-required key as optional", () => {
    // Nullable must still be WRITTEN, so every recorded payload already pins it.
    expect(optionalFieldPaths(z.strictObject({ winner: z.string().nullable() }))).toEqual([]);
  });

  it("sees through .readonly() to the key underneath", () => {
    const schema = z.strictObject({ seed: z.number().optional().readonly() });
    expect(optionalFieldPaths(schema)).toEqual(["seed"]);
  });

  it("reports nothing for a schema that is not an object at all", () => {
    expect(optionalFieldPaths(z.string())).toEqual([]);
  });

  it("walks a REAL module union — football declares `at` optional and `by` not", () => {
    const paths = optionalFieldPaths(football.eventSchema);
    // Spot-pins, not a snapshot: `at` is the whole point of W4a, `addedMinutes`
    // and `goalkeeper` are W4 additions on two different branches, and `by` is
    // required on six of the eight branches.
    expect(paths).toContain("at");
    expect(paths).toContain("addedMinutes");
    expect(paths).toContain("goalkeeper");
    expect(paths).not.toContain("by");
    expect(paths).not.toContain("outcome"); // required on FootballPenalty
    expect(paths).toEqual([...paths].sort());
  });
});

describe("fieldPresent", () => {
  it("finds a top-level key that is written", () => {
    expect(fieldPresent({ by: "H", minute: 12 }, "minute")).toBe(true);
  });

  it("does not find a key that is absent", () => {
    expect(fieldPresent({ by: "H" }, "minute")).toBe(false);
  });

  it("treats an explicitly undefined value as absent", () => {
    expect(fieldPresent({ minute: undefined }, "minute")).toBe(false);
  });

  it("counts a falsy written value as present", () => {
    // `ownGoal: false` and `elapsed: 0` are recorded facts, not absences.
    expect(fieldPresent({ ownGoal: false }, "ownGoal")).toBe(true);
    expect(fieldPresent({ at: { elapsed: 0 } }, "at.elapsed")).toBe(true);
  });

  it("walks a dotted path", () => {
    expect(fieldPresent({ at: { period: "H1", elapsed: 30 } }, "at.period")).toBe(true);
    expect(fieldPresent({ at: { elapsed: 30 } }, "at.period")).toBe(false);
    expect(fieldPresent({ by: "H" }, "at.period")).toBe(false);
  });

  it("finds a key on ANY element of an array segment", () => {
    expect(fieldPresent({ assists: [{ person: "p1" }, { person: "p2", secondary: true }] }, "assists[].secondary")).toBe(true);
    expect(fieldPresent({ assists: [{ person: "p1" }] }, "assists[].secondary")).toBe(false);
    expect(fieldPresent({ assists: [] }, "assists[].secondary")).toBe(false);
  });

  it("does not mistake an array for an object, or a scalar for either", () => {
    expect(fieldPresent([{ minute: 1 }], "minute")).toBe(false);
    expect(fieldPresent("minute", "minute")).toBe(false);
    expect(fieldPresent(null, "minute")).toBe(false);
    expect(fieldPresent({ at: "H1" }, "at.period")).toBe(false);
  });
});

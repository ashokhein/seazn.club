// Property tests (PROMPT-21 acceptance): planImport idempotence, dedupe, and
// the DIVISION_NOT_FOUND guarantee, over arbitrary row sets.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planImport } from "./plan.ts";
import { ImportConfig, type ImportRow, type ImportSnapshot } from "./types.ts";
import { applyPlanToSnapshot } from "./plan.test.ts";

const CONFIG = ImportConfig.parse({});

const DIVISIONS: ImportSnapshot["divisions"] = [
  { id: "d1", name: "Open League", slug: "open", sportKey: "football", positionKeys: ["gk", "mid"] },
];
const SNAPSHOT: ImportSnapshot = { clubs: [], teams: [], persons: [], divisions: DIVISIONS, entrants: [] };

// Small name pools force collisions, which is where dedupe bugs live.
const clubName = fc.constantFrom("Acme", "Borough", "City", "Dale");
const teamName = fc.constantFrom("U12", "U14", "Firsts", "Reserves");
const personName = fc.constantFrom("Alex Ash", "Bo Berg", "Cai Cole", "Dee Dunn");
const slug = fc.constantFrom("open", "nope", "missing");

const arbitraryRow = (rowNo: number): fc.Arbitrary<ImportRow> =>
  fc
    .record(
      {
        clubName: fc.option(clubName, { nil: undefined }),
        teamName: fc.option(teamName, { nil: undefined }),
        playerFullName: fc.option(personName, { nil: undefined }),
        dob: fc.option(fc.constantFrom("2010-01-01", "2012-02-02"), { nil: undefined }),
        squadNumber: fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
        position: fc.option(fc.constantFrom("gk", "mid"), { nil: undefined }),
        isCaptain: fc.option(fc.boolean(), { nil: undefined }),
        divisionSlug: fc.option(slug, { nil: undefined }),
      },
      { requiredKeys: [] },
    )
    .map((r) => ({ rowNo, ...r }));

const arbitraryRows = fc
  .integer({ min: 0, max: 25 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbitraryRow(i + 1))));

describe("planImport properties (PROMPT-21)", () => {
  it("apply a plan, rebuild the snapshot, re-plan the same rows ⇒ ops == []", () => {
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        const plan = planImport(rows, SNAPSHOT, CONFIG);
        const after = applyPlanToSnapshot(plan, SNAPSHOT);
        const replan = planImport(rows, after, CONFIG);
        expect(replan.ops).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("dedupe never emits a second club.create/person.create for a matching entity", () => {
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        const plan = planImport(rows, SNAPSHOT, CONFIG);
        const clubRefs = plan.ops.filter((o) => o.kind === "club.create").map((o) => o.ref);
        expect(new Set(clubRefs).size).toBe(clubRefs.length);
        const personRefs = plan.ops.filter((o) => o.kind === "person.create").map((o) => o.ref);
        expect(new Set(personRefs).size).toBe(personRefs.length);
      }),
      { numRuns: 200 },
    );
  });

  it("unknown divisionSlug always yields error DIVISION_NOT_FOUND and never an entrant/roster op", () => {
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        const plan = planImport(rows, SNAPSHOT, CONFIG);
        const badRows = rows
          .filter((r) => r.divisionSlug !== undefined && r.divisionSlug !== "open")
          .map((r) => r.rowNo);
        for (const rowNo of badRows) {
          expect(
            plan.issues.some((i) => i.rowNo === rowNo && i.code === "DIVISION_NOT_FOUND"),
          ).toBe(true);
          for (const op of plan.ops) {
            if (op.kind === "entrant.create" || op.kind === "roster.add") {
              expect(op.sourceRows).not.toContain(rowNo);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("determinism: same inputs ⇒ identical plan", () => {
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        const a = planImport(rows, SNAPSHOT, CONFIG);
        const b = planImport(rows, SNAPSHOT, CONFIG);
        expect(b).toEqual(a);
      }),
      { numRuns: 100 },
    );
  });
});

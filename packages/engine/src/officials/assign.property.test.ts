// Property tests (PROMPT-22 acceptance, ≤64 fixtures): no double-booking,
// team-ref-self never, poolLock respected, all-locked idempotence.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assignOfficials } from "./assign.ts";
import {
  AssignPolicy,
  type FixtureOfficial,
  type OfficialFixture,
  type OfficialSpec,
} from "./types.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 4, 9, 0, 0);

const ENTRANTS = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"];
const POOLS = ["pA", "pB"];

const arbitraryFixtures = fc
  .integer({ min: 1, max: 64 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc
          .record({
            slot: fc.integer({ min: 0, max: 15 }),
            court: fc.constantFrom("C1", "C2", "C3"),
            pool: fc.option(fc.constantFrom(...POOLS), { nil: undefined }),
            pair: fc.integer({ min: 0, max: ENTRANTS.length - 2 }),
          })
          .map(({ slot, court, pool, pair }): OfficialFixture => ({
            id: `f${i}`,
            startAt: T0 + slot * 30 * MIN,
            endAt: T0 + (slot + 1) * 30 * MIN,
            court,
            poolId: pool,
            entrants: [ENTRANTS[pair]!, ENTRANTS[pair + 1]!],
          })),
      ),
    ),
  );

const arbitraryOfficials = fc
  .integer({ min: 1, max: 8 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc
          .record({
            teamRef: fc.option(fc.constantFrom(...ENTRANTS), { nil: undefined }),
            homePool: fc.option(fc.constantFrom(...POOLS), { nil: undefined }),
            maxPerDay: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
          })
          .map(({ teamRef, homePool, maxPerDay }): OfficialSpec => ({
            id: `o${i}`,
            roleKeys: ["referee"],
            entrantIds: teamRef ? [teamRef] : undefined,
            homePoolId: homePool,
            maxPerDay,
          })),
      ),
    ),
  );

const arbitraryPolicy = fc
  .record({
    poolLock: fc.boolean(),
    blockStay: fc.boolean(),
    fairness: fc.constantFrom("tournament" as const, "per_day" as const),
    restMinMinutes: fc.constantFrom(0, 10),
  })
  .map((p) => AssignPolicy.parse({ roles: ["referee"], ...p }));

describe("assignOfficials properties (PROMPT-22)", () => {
  it("no official is double-booked; team-ref never officiates own or parallel-play fixtures; poolLock holds", () => {
    fc.assert(
      fc.property(
        arbitraryFixtures,
        arbitraryOfficials,
        arbitraryPolicy,
        (fixtures, officials, policy) => {
          const { assignments } = assignOfficials({
            fixtures,
            officials,
            locked: [],
            policy,
            rngSeed: "prop",
          });
          const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
          const officialById = new Map(officials.map((o) => [o.id, o]));

          // no double-booking (rest ignored — plain interval overlap)
          const byOfficial = new Map<string, OfficialFixture[]>();
          for (const a of assignments) {
            const f = fixtureById.get(a.fixtureId)!;
            const list = byOfficial.get(a.officialId) ?? [];
            for (const other of list) {
              expect(other.startAt < f.endAt && f.startAt < other.endAt).toBe(false);
            }
            list.push(f);
            byOfficial.set(a.officialId, list);
          }
          for (const a of assignments) {
            const f = fixtureById.get(a.fixtureId)!;
            const o = officialById.get(a.officialId)!;
            // never own fixture
            expect(o.entrantIds?.some((e) => f.entrants.includes(e)) ?? false).toBe(false);
            // never while playing
            if (o.entrantIds) {
              const mine = new Set(o.entrantIds);
              for (const p of fixtures) {
                if (p.entrants.some((e) => mine.has(e))) {
                  expect(p.startAt < f.endAt && f.startAt < p.endAt).toBe(false);
                }
              }
            }
            // poolLock
            if (policy.poolLock && o.homePoolId !== undefined && f.poolId !== undefined) {
              expect(o.homePoolId).toBe(f.poolId);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("all-locked re-run makes zero moves (idempotence, mirrors PROMPT-17 §3)", () => {
    fc.assert(
      fc.property(
        arbitraryFixtures,
        arbitraryOfficials,
        arbitraryPolicy,
        (fixtures, officials, policy) => {
          const first = assignOfficials({
            fixtures,
            officials,
            locked: [],
            policy,
            rngSeed: "prop",
          });
          const locked: FixtureOfficial[] = first.assignments.map((a) => ({
            ...a,
            locked: true,
          }));
          const second = assignOfficials({
            fixtures,
            officials,
            locked,
            policy,
            rngSeed: "prop",
          });
          const fresh = second.assignments.filter((a) => !a.locked);
          expect(fresh).toEqual([]);
          // and no locked assignment got flagged as a block conflict
          expect(
            second.conflicts.filter(
              (c) => c.severity === "block" && c.kind !== "role_unfilled",
            ),
          ).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("determinism: same inputs ⇒ identical result", () => {
    fc.assert(
      fc.property(arbitraryFixtures, arbitraryOfficials, (fixtures, officials) => {
        const policy = AssignPolicy.parse({ roles: ["referee"], blockStay: true });
        const a = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: "x" });
        const b = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: "x" });
        expect(b).toEqual(a);
      }),
      { numRuns: 80 },
    );
  });
});

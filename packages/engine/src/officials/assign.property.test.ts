// Property tests (PROMPT-22 acceptance, ≤64 fixtures): no double-booking,
// team-ref-self never, poolLock respected, all-locked idempotence.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assignOfficials } from "./assign.ts";
import { dayKeyInTz } from "../scheduling/tz.ts";
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

/** Zones chosen so the generated board straddles a UTC midnight from BOTH
 *  sides (#448): west of Greenwich a local evening is already the next UTC day,
 *  east of it a local morning is still the previous one. "UTC" stays in the
 *  set so the degenerate case keeps its coverage. */
const TIMEZONES = ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata"];
const arbitraryTz = fc.constantFrom(...TIMEZONES);

const arbitraryFixtures = fc
  .integer({ min: 1, max: 64 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc
          .record({
            // 48 half-hour slots from 09:00Z = a full 24h span, so fixtures
            // land on both sides of a UTC midnight AND of a local one.
            slot: fc.integer({ min: 0, max: 47 }),
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
  it("no official is double-booked; team-ref never officiates own or parallel-play fixtures; poolLock holds; maxPerDay holds per ORG day", () => {
    fc.assert(
      fc.property(
        arbitraryFixtures,
        arbitraryOfficials,
        arbitraryPolicy,
        arbitraryTz,
        (fixtures, officials, policy, tz) => {
          const { assignments } = assignOfficials({
            fixtures,
            officials,
            locked: [],
            policy,
            rngSeed: "prop",
            tz,
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

          // maxPerDay is a HARD cap, counted on the calendar day in the org
          // zone (#448) — never the UTC day, which used to let an official
          // west of Greenwich work two "days" in one local evening.
          const perOfficialDay = new Map<string, number>();
          for (const a of assignments) {
            const f = fixtureById.get(a.fixtureId)!;
            const key = `${a.officialId}|${dayKeyInTz(f.startAt, tz)}`;
            perOfficialDay.set(key, (perOfficialDay.get(key) ?? 0) + 1);
          }
          for (const [key, n] of perOfficialDay) {
            const cap = officialById.get(key.slice(0, key.indexOf("|")))!.maxPerDay;
            if (cap !== undefined) expect(n).toBeLessThanOrEqual(cap);
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
        arbitraryTz,
        (fixtures, officials, policy, tz) => {
          const first = assignOfficials({
            fixtures,
            officials,
            locked: [],
            policy,
            rngSeed: "prop",
            tz,
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
            tz,
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
      fc.property(arbitraryFixtures, arbitraryOfficials, arbitraryTz, (fixtures, officials, tz) => {
        const policy = AssignPolicy.parse({ roles: ["referee"], blockStay: true });
        const a = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: "x", tz });
        const b = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: "x", tz });
        expect(b).toEqual(a);
      }),
      { numRuns: 80 },
    );
  });
});

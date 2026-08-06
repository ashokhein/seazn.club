// #350 Task 1 — buildCompetitionPack acceptance. One competition, several
// divisions, one joint pack: every fixture/obstacle/assignment carries the
// division it belongs to, courts are unioned (and divergence named), each
// division keeps its OWN settings, a selected division never appears as its own
// obstacle, and the whole thing is byte-for-byte deterministic.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { buildCompetitionPack, COMPETITION_MOVABLE_CAP, verifyJoint } from "../competition-schedule-ai";
import { buildSchedulePack, isBlocking, OTHER_DIVISION_LABEL } from "../schedule-ai";
import { seedOrg } from "./_seed";

// A pass-through spy over the real implementation — it changes no behaviour and
// exists so the cap pre-check can assert directly that NO per-division build
// ran, instead of piggybacking on some other error arriving first.
vi.mock("../schedule-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai")>();
  return { ...actual, buildSchedulePack: vi.fn(actual.buildSchedulePack) };
});

const HAS_DB = !!process.env.DATABASE_URL;

// #397: the pack builder reads no clock — `now` is injected, so a frozen
// instant here is what keeps the pack (and its golden snapshot) reproducible.
// 2026-08-06T23:30Z is already Friday the 7th in London, which is the point:
// the pack's "today" is a fact about the ORG zone, not about UTC.
const NOW_W2 = Date.parse("2026-08-06T23:30:00Z");


const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Fixed instants → the pack (times, offsets) is stable across runs.
const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const MIN = 60_000;
const TZ = "Europe/London";

function settingsConfig(courts: string[], matchMinutes: number, windowMinutes = 720) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [
      { from: "2026-08-01T09:00:00.000Z", to: new Date(T0 + windowMinutes * MIN).toISOString() },
    ],
    constraints: {
      restMin: 0,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "balance",
      parallelism: "mixed",
      crossPersonClash: "hard",
    },
  };
}

// Same redaction idiom as schedule-ai-pack.test.ts:151 — UUIDs are per-seed
// random, so map them to first-seen placeholders and compare the structure.
function redact(pack: unknown): unknown {
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const map = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(pack).replace(re, (u) => {
      if (!map.has(u)) map.set(u, `<id:${map.size + 1}>`);
      return map.get(u)!;
    }),
  );
}

interface DivSpec {
  name: string;
  /** Defaults to a slugified `name`. Set explicitly to seed same-NAMED
   *  divisions — `createDivision` enforces a unique slug, not a unique name. */
  slug?: string;
  courts: string[];
  matchMinutes: number;
  /** Round-robin entrant count; 4 → 6 fixtures. */
  entrants: number;
  /** Defaults to the slug. Entrant display names are a stable domain sort key. */
  entrantPrefix?: string;
  /** Persist a court/time on every fixture (the placements the joint pack must
   *  NOT re-serve as obstacles for a selected division). */
  place: boolean;
  /** Minutes past T0 the first fixture lands on. */
  startOffsetMin: number;
  /** Mark the first placed fixture `finalized` — occupying but NOT movable, so
   *  it stays an obstacle of its own division even when that division is in the
   *  run. */
  finalizeFirst?: boolean;
  /** Session-window length from T0. Shrink it to seed a board that cannot fit. */
  windowMinutes?: number;
}

interface SeededDivision {
  id: string;
  name: string;
  slug: string;
  fixtureCount: number;
  /** Fixture ids in (round_no, seq_in_round) order — the placement order. */
  fixtureIds: string[];
}

/** A whole competition of divisions on STABLE domain keys (never fixture UUIDs)
 *  so an identically-specced reseed produces the same logical pack. */
async function seedCompetition(
  auth: AuthCtx,
  compName: string,
  specs: DivSpec[],
): Promise<{ competitionId: string; divisions: SeededDivision[] }> {
  // The joint pack's ONE clock is the ORGANISATION zone (#397). These boards
  // have always been London boards — they just said so on the division rows.
  // Saying it on the org row keeps every existing offset assertion true, so the
  // W2 diff is the four added fields and not a re-render of the whole pack.
  await sql`update organizations set timezone = ${TZ} where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: compName, visibility: "public", branding: {} });
  const divisions: SeededDivision[] = [];
  for (const spec of specs) {
    const slug = spec.slug ?? spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const prefix = spec.entrantPrefix ?? slug;
    const division = await createDivision(auth, comp.id, {
      name: spec.name,
      slug,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: spec.entrants }, (_, i) => ({
        kind: "individual" as const,
        display_name: `${prefix}-E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${division.id}, ${sql.json(
        settingsConfig(spec.courts, spec.matchMinutes, spec.windowMinutes),
      )}, ${TZ}, now())
      on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const ordered = [...fixtures].sort(
      (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
    );
    if (spec.place) {
      for (let i = 0; i < ordered.length; i++) {
        await sql`
          update fixtures set
            scheduled_at = ${new Date(
              T0 + (spec.startOffsetMin + i * spec.matchMinutes) * MIN,
            ).toISOString()},
            court_label = ${spec.courts[i % spec.courts.length]!},
            schedule_source = 'auto'
          where id = ${ordered[i]!.id}`;
      }
      if (spec.finalizeFirst === true) {
        await sql`update fixtures set status = 'finalized' where id = ${ordered[0]!.id}`;
      }
    }
    divisions.push({
      id: division.id,
      name: spec.name,
      slug,
      fixtureCount: fixtures.length,
      fixtureIds: ordered.map((f) => f.id),
    });
  }
  return { competitionId: comp.id, divisions };
}

/** Bulk fixture seeder — direct inserts (no generator) to reach the joint cap. */
async function seedBigDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  n: number,
): Promise<string> {
  const division = await createDivision(auth, competitionId, {
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(["Court 1", "Court 2"], 30))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    select ${stage!.id}, ${division.id}, ${auth.orgId}, (g / 20)::int, (g % 20)::int, 'big-' || lpad(g::text, 5, '0'), 'scheduled'
    from generate_series(1, ${n}) g`;
  return division.id;
}

/** The shared 3-division board: A and B are selected, C is the excluded one. */
const BOARD: DivSpec[] = [
  { name: "Alpha", courts: ["Court 1", "Court 2"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0 },
  { name: "Bravo", courts: ["Court 2", "Court 3"], matchMinutes: 45, entrants: 4, place: true, startOffsetMin: 240 },
  { name: "Charlie", courts: ["Court 4"], matchMinutes: 60, entrants: 4, place: true, startOffsetMin: 480 },
];

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("buildCompetitionPack (#350)", () => {
  let auth: AuthCtx;
  let competitionId: string;
  let divisions: SeededDivision[];
  const RR = (4 * 3) / 2; // 6 round-robin fixtures per division

  beforeAll(async () => {
    ({ auth } = await seedOrg("pro"));
    ({ competitionId, divisions } = await seedCompetition(auth, "Joint Cup", BOARD));
  }, 60_000);

  const selected = (): string[] => [divisions[0]!.id, divisions[1]!.id];

  it("unions two divisions' movable fixtures and tags every one with its division", async () => {
    const { pack, movableIds } = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "Fit both divisions in the day.",
    });
    expect(pack.fixtures.movable.length).toBe(RR * 2);
    expect(movableIds.size).toBe(RR * 2);
    const ids = new Set(selected());
    for (const f of pack.fixtures.movable) expect(ids.has(f.division_id)).toBe(true);
    for (const side of selected()) {
      expect(pack.fixtures.movable.filter((f) => f.division_id === side).length).toBe(RR);
    }
    expect(pack.competition.id).toBe(competitionId);
    expect(pack.competition.name).toBe("Joint Cup");
    expect(pack.divisions.map((d) => d.name)).toEqual(["Alpha", "Bravo"]);
    for (const d of pack.divisions) expect(d.movableIds.length).toBe(RR);
    // Entrants carry their division too.
    expect(pack.entrants.length).toBe(8);
    for (const e of pack.entrants) expect(ids.has(e.division_id)).toBe(true);
    // Draft assignments are tagged the same way.
    for (const a of pack.draft) expect(ids.has(a.division_id)).toBe(true);
  }, 60_000);

  it("courts is the union of both divisions' labels, sorted", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    expect(pack.courts).toEqual(["Court 1", "Court 2", "Court 3"]);
  }, 60_000);

  it("divergentCourts names the labels that are not in every division", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    expect(pack.divergentCourts).toEqual(["Court 1", "Court 3"]);

    // Identical court lists → nothing divergent.
    const same = await seedCompetition(auth, "Same Courts", [
      { name: "Delta", courts: ["Court 1", "Court 2"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
      { name: "Echo", courts: ["Court 1", "Court 2"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
    ]);
    const flat = await buildCompetitionPack(
      auth,
      same.competitionId,
      same.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    expect(flat.pack.courts).toEqual(["Court 1", "Court 2"]);
    expect(flat.pack.divergentCourts).toEqual([]);
  }, 60_000);

  // The domain property, stated as an EXACT multiset rather than as the
  // implementation's own predicate. A "no obstacle shares (court, start) with a
  // selected movable fixture" assertion only catches under-removal — it is
  // satisfied just as well by deleting too much, which is the failure this
  // whole block exists to prevent.
  //
  // Seed: Hotel and India are selected and share Court 1; Juliet is excluded and
  // is deliberately placed on Court 1 at EXACTLY Hotel's instants. So the run's
  // own 12 placements must vanish from the obstacles and Juliet's 6 must
  // survive — even though every one of them collides with a selected division's
  // slot. A slot-key removal cannot tell those two cases apart and deletes a
  // hard constraint with no trace: obstacles are what Task 3's verifier reads,
  // so nothing downstream can recover it.
  async function seedOverlapCup(): Promise<{ competitionId: string; divisions: SeededDivision[] }> {
    return seedCompetition(auth, `Overlap Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Hotel", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0 },
      { name: "India", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 600 },
      // Same court, same instants as Hotel.
      { name: "Juliet", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0 },
    ]);
  }

  it("the obstacles removed are exactly the selected divisions' own placements", async () => {
    const cup = await seedOverlapCup();
    const [hotel, india, juliet] = cup.divisions as [SeededDivision, SeededDivision, SeededDivision];
    const { pack } = await buildCompetitionPack(auth, cup.competitionId, [hotel.id, india.id], {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    // Hotel's 6 instants, which are also Juliet's 6 instants.
    const hotelStarts = Array.from({ length: RR }, (_, i) => T0 + i * 30 * MIN);
    const indiaStarts = Array.from({ length: RR }, (_, i) => T0 + (600 + i * 30) * MIN);

    // Every surviving obstacle is Juliet's — the ONE division outside the run.
    expect(pack.fixtures.obstacles.map((o) => o.division_id)).toEqual(
      Array.from({ length: RR }, () => null),
    );
    expect(pack.fixtures.obstacles.map((o) => Date.parse(o.from)).sort((a, b) => a - b)).toEqual(
      hotelStarts,
    );
    for (const o of pack.fixtures.obstacles) {
      expect(o.court).toBe("Court 1");
      expect(o.label).toBe(OTHER_DIVISION_LABEL);
    }
    // Neither selected division's own placements survived as obstacles: India's
    // slots are disjoint from Juliet's, so any obstacle at one of them is a
    // selected division re-served to itself.
    for (const o of pack.fixtures.obstacles) {
      expect(indiaStarts).not.toContain(Date.parse(o.from));
    }
    // Sanity: the seed really did collide, or the test proves nothing.
    expect(juliet.fixtureIds.length).toBe(RR);
    const movableStarts = pack.fixtures.movable
      .filter((f) => f.division_id === hotel.id)
      .map((f) => Date.parse(f.current.at!))
      .sort((a, b) => a - b);
    expect(movableStarts).toEqual(hotelStarts);
  }, 60_000);

  it("an excluded division's placement colliding with a selected fixture still survives as an obstacle", async () => {
    const cup = await seedOverlapCup();
    const [hotel, india] = cup.divisions as [SeededDivision, SeededDivision, SeededDivision];
    const { pack } = await buildCompetitionPack(auth, cup.competitionId, [hotel.id, india.id], {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    // Juliet occupies Court 1 at 09:00 and so does a movable Hotel fixture.
    // The obstacle is the excluded division's real, immovable court booking.
    const at0900 = pack.fixtures.obstacles.filter(
      (o) => o.court === "Court 1" && Date.parse(o.from) === T0,
    );
    expect(at0900.length).toBe(1);
    expect(at0900[0]!.division_id).toBe(null);
    expect(
      pack.fixtures.movable.some(
        (f) => f.division_id === hotel.id && f.current.court === "Court 1" && Date.parse(f.current.at!) === T0,
      ),
    ).toBe(true);
  }, 60_000);

  it("two selected divisions' own immovable fixtures at one slot are both kept, each tagged", async () => {
    // M5: a dedupe key without division identity collapses these into one entry
    // tagged with whichever division built first, hiding a real fixture from
    // both the model and the verifier.
    const cup = await seedCompetition(auth, `Dup Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Kilo", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0, finalizeFirst: true },
      { name: "Lima", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0, finalizeFirst: true },
    ]);
    const [kilo, lima] = cup.divisions as [SeededDivision, SeededDivision];
    const { pack } = await buildCompetitionPack(auth, cup.competitionId, [kilo.id, lima.id], {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    const at0900 = pack.fixtures.obstacles.filter(
      (o) => o.court === "Court 1" && Date.parse(o.from) === T0,
    );
    expect(at0900.length).toBe(2);
    expect(at0900.map((o) => o.division_id).sort()).toEqual([kilo.id, lima.id].sort());
  }, 60_000);

  it("an excluded division's placements are obstacles with a null division_id", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    const foreign = pack.fixtures.obstacles.filter((o) => o.division_id === null);
    // Charlie is not in the run: all 6 of its placements are obstacles, once each.
    expect(foreign.length).toBe(RR);
    for (const o of foreign) {
      expect(o.court).toBe("Court 4");
      // The shared literal, imported — not a copy. A silent divergence here is
      // what would stop sibling removal from recognising a foreign obstacle.
      expect(o.label).toBe(OTHER_DIVISION_LABEL);
    }
    // …and no duplicates survived the union of two source packs.
    expect(new Set(foreign.map((o) => `${o.court}|${o.from}|${o.to}`)).size).toBe(RR);
  }, 60_000);

  it("per-division settings are carried verbatim, not merged", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    const alpha = pack.divisions.find((d) => d.name === "Alpha")!;
    const bravo = pack.divisions.find((d) => d.name === "Bravo")!;
    expect(alpha.settings.matchMinutes).toBe(30);
    expect(bravo.settings.matchMinutes).toBe(45);
    expect(alpha.settings.courts).toEqual(["Court 1", "Court 2"]);
    expect(bravo.settings.courts).toEqual(["Court 2", "Court 3"]);
    expect(alpha.tz).toBe(TZ);
    expect(alpha.sport).toBe("generic");
  }, 60_000);

  // The draft is the model's anchor, and credits buy a FIXED generation-token
  // budget with no true-up (lib/ai-rung.ts). A draft that double-books a shared
  // court anchors the model on an illegal board and burns repair rounds the org
  // paid for — so the pack must not ship one. Two divisions, one shared court,
  // nothing pre-placed: the ONLY thing that can keep them apart is the joint
  // build feeding each division's greedy solve the drafts already committed by
  // the divisions before it.
  it("the joint draft never double-books a shared court across divisions", async () => {
    const shared = await seedCompetition(auth, "Shared Court", [
      { name: "Foxtrot", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
      { name: "Golf", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
    ]);
    const { pack } = await buildCompetitionPack(
      auth,
      shared.competitionId,
      shared.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    expect(pack.courts).toEqual(["Court 1"]);
    expect(pack.divergentCourts).toEqual([]);
    // Both divisions must actually have drafted, or the overlap sweep below is
    // vacuous — a builder that simply dropped the second division would pass.
    expect(pack.draft.length).toBe(RR * 2);
    for (const d of pack.divisions) {
      expect(pack.draft.filter((a) => a.division_id === d.id).length).toBe(RR);
    }
    const minutes = new Map(pack.divisions.map((d) => [d.id, d.settings.matchMinutes]));
    const spans = pack.draft.map((a) => {
      const from = Date.parse(a.scheduled_at!);
      return {
        court: a.court_label,
        division_id: a.division_id,
        fixture_id: a.fixture_id,
        from,
        to: from + minutes.get(a.division_id)! * MIN,
      };
    });
    const clashes: string[] = [];
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const x = spans[i]!;
        const y = spans[j]!;
        if (x.division_id === y.division_id) continue;
        if (x.court !== y.court) continue;
        if (x.from < y.to && y.from < x.to) {
          clashes.push(`${x.court} ${new Date(x.from).toISOString()}: ${x.fixture_id} vs ${y.fixture_id}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  }, 60_000);

  // Excluding the run from the sibling sweep (I1) also took the run's own
  // IMMOVABLE fixtures out of every division's greedy view. Feeding each built
  // division's obstacles forward only closes that one way — the division built
  // FIRST still never sees a later division's fixed board, so it can draft on
  // top of a fixture nothing can move. Same defect class as the round-1 court
  // clash: a knowingly-illegal hint the model may anchor on, paid for out of a
  // fixed token budget.
  //
  // Alpha2 sorts first and has nothing placed; Bravo2 holds Court 1 at 09:00
  // with a finalized fixture. Alpha2's greedy pass starts at 09:00 on Court 1
  // unless something stops it.
  it("no division's draft sits on another division's immovable fixture", async () => {
    const cup = await seedCompetition(auth, `Fixed Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Alpha2", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
      { name: "Bravo2", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: true, startOffsetMin: 0, finalizeFirst: true },
    ]);
    const [alpha2, bravo2] = cup.divisions as [SeededDivision, SeededDivision];
    const { pack } = await buildCompetitionPack(
      auth,
      cup.competitionId,
      cup.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    // The immovable fixture really is in the pack, tagged to its own division.
    const fixed = pack.fixtures.obstacles.filter(
      (o) => o.division_id === bravo2.id && o.court === "Court 1" && Date.parse(o.from) === T0,
    );
    expect(fixed.length).toBe(1);
    // Alpha2 is built first and drafts a full board — so it really did compete
    // for that slot; a starved or empty draft would make this vacuous.
    const alphaDivision = pack.divisions.find((d) => d.id === alpha2.id)!;
    expect(pack.divisions[0]!.id).toBe(alpha2.id);
    expect(alphaDivision.draftPlaced).toBe(RR);
    expect(pack.draft.some((a) => a.division_id === alpha2.id && a.court_label === "Court 1")).toBe(true);

    const minutes = new Map(pack.divisions.map((d) => [d.id, d.settings.matchMinutes]));
    const overlaps: string[] = [];
    for (const a of pack.draft) {
      if (a.court_label !== "Court 1") continue;
      const from = Date.parse(a.scheduled_at!);
      const to = from + minutes.get(a.division_id)! * MIN;
      if (from < T0 + 30 * MIN && T0 < to) {
        overlaps.push(`${a.fixture_id} @ ${new Date(from).toISOString()}`);
      }
    }
    expect(overlaps).toEqual([]);
  }, 60_000);

  // C1: the fixed board must carry its PEOPLE. Under `crossPersonClash: "hard"`
  // slotFixtures rejects a placement overlapping anyone already committed in
  // `existing` (calendar.ts:275-283), so an empty `people[]` silently disables
  // that block and lets a draft double-book a person against a finalized
  // fixture nobody can move. Unlike the drafts, these rows come from this
  // module's own SQL, so the data IS available.
  //
  // AlphaP is built first and uses Court 1; BravoP holds Court 2 at 09:00 with a
  // finalized fixture. Different courts, so ONLY the person block can move
  // AlphaP off 09:00. Two entrants each → exactly one fixture each, so there is
  // no ambiguity about which slot the greedy pass wants.
  it("a draft never double-books a person committed to another division's fixed fixture", async () => {
    const cup = await seedCompetition(auth, `People Clash ${randomUUID().slice(0, 6)}`, [
      { name: "AlphaP", courts: ["Court 1"], matchMinutes: 30, entrants: 2, place: false, startOffsetMin: 0 },
      { name: "BravoP", courts: ["Court 2"], matchMinutes: 30, entrants: 2, place: true, startOffsetMin: 0, finalizeFirst: true },
    ]);
    const [alphaP, bravoP] = cup.divisions as [SeededDivision, SeededDivision];
    const [{ id: person }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Cross Division Player') returning id`;
    for (const d of [alphaP, bravoP]) {
      const [e1] = await sql<{ id: string }[]>`
        select id from entrants where division_id = ${d.id} order by seed limit 1`;
      await sql`insert into entrant_members (entrant_id, person_id, org_id)
                values (${e1!.id}, ${person}, ${auth.orgId})`;
    }
    const { pack } = await buildCompetitionPack(auth, cup.competitionId, [alphaP.id, bravoP.id], {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    // BravoP's finalized fixture is on the board, on its OWN court — so court
    // occupancy cannot be what moves AlphaP.
    const fixed = pack.fixtures.obstacles.filter(
      (o) => o.division_id === bravoP.id && o.court === "Court 2" && Date.parse(o.from) === T0,
    );
    expect(fixed.length).toBe(1);
    expect(pack.divisions[0]!.id).toBe(alphaP.id);

    const alphaDraft = pack.draft.filter((a) => a.division_id === alphaP.id);
    expect(alphaDraft.length).toBe(1);
    expect(alphaDraft[0]!.court_label).toBe("Court 1");
    // The shared person is committed until 09:30, so AlphaP cannot start at 09:00.
    expect(Date.parse(alphaDraft[0]!.scheduled_at!)).toBeGreaterThanOrEqual(T0 + 30 * MIN);
  }, 60_000);

  // I2: sequential accumulation means a board that does not fit starves the
  // LAST divisions — slotFixtures returns their fixtures as `no_slot` conflicts
  // and schedule-ai.ts discards conflicts, so `draft` is simply short. Without a
  // per-division count nobody downstream can tell a complete draft from a
  // truncated one.
  it("reports a partial draft per division when the board cannot fit", async () => {
    const cup = await seedCompetition(auth, `Tight Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Mike", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0, windowMinutes: 120 },
      { name: "November", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0, windowMinutes: 120 },
    ]);
    const { pack } = await buildCompetitionPack(
      auth,
      cup.competitionId,
      cup.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const mike = pack.divisions.find((d) => d.name === "Mike")!;
    const november = pack.divisions.find((d) => d.name === "November")!;
    // 1 court × a 2h window ÷ 30m = 4 slots for 12 movable fixtures.
    expect(mike.movableIds.length).toBe(RR);
    expect(november.movableIds.length).toBe(RR);
    expect(pack.draft.length).toBeLessThanOrEqual(4);
    expect(mike.draftPlaced + november.draftPlaced).toBe(pack.draft.length);
    // Both are partial, and the later division is the starved one.
    expect(mike.draftPlaced).toBeLessThan(mike.movableIds.length);
    expect(november.draftPlaced).toBeLessThan(november.movableIds.length);
    expect(november.draftPlaced).toBeLessThan(mike.draftPlaced);
    // A board that DOES fit reports a complete draft, so the signal is not
    // simply always-partial.
    const roomy = await buildCompetitionPack(auth, competitionId, selected(), {
      now: NOW_W2,
      mode: "generate",
      instruction: "x",
    });
    for (const d of roomy.pack.divisions) expect(d.draftPlaced).toBe(d.movableIds.length);
  }, 60_000);

  it("merges a shared person's entrant ids in global name order", async () => {
    // M10: entrant-id arrays order on the entrant NAME (schedule-ai.ts:517-523, applied at :542).
    // Oscar sorts before Papa, but Oscar's entrants are named zz-* and Papa's
    // aa-*, so appending Papa's ids to Oscar's breaks the invariant.
    const cup = await seedCompetition(auth, `People Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Oscar", entrantPrefix: "zz", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
      { name: "Papa", entrantPrefix: "aa", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
    ]);
    const [{ id: person }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Two Division Player') returning id`;
    for (const d of cup.divisions) {
      const ents = await sql<{ id: string }[]>`
        select id from entrants where division_id = ${d.id} order by seed limit 2`;
      for (const e of ents) {
        await sql`insert into entrant_members (entrant_id, person_id, org_id)
                  values (${e.id}, ${person}, ${auth.orgId})`;
      }
    }
    const { pack } = await buildCompetitionPack(
      auth,
      cup.competitionId,
      cup.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    expect(pack.people.length).toBe(1);
    const nameById = new Map(pack.entrants.map((e) => [e.id, e.name]));
    expect(pack.people[0]!.entrant_ids.map((e) => nameById.get(e))).toEqual([
      "aa-E1",
      "aa-E2",
      "zz-E1",
      "zz-E2",
    ]);
  }, 60_000);

  it("carries a person shared across two divisions, invisible to either alone", async () => {
    // The whole reason the joint people map cannot be a union of the per-division
    // maps. schedule-ai.ts:540-543 keeps only persons in >= 2 entrants of THAT
    // division, so someone rostered into one entrant of A and one of B clears the
    // bar in neither and is in NEITHER source map — while H4 sends the model to
    // that very map to avoid entrant overlaps. Building it over the run's whole
    // entrant set is what makes the clash avoidable rather than merely detectable.
    const cup = await seedCompetition(auth, `Cross Cup ${randomUUID().slice(0, 6)}`, [
      { name: "Quebec", entrantPrefix: "qq", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
      { name: "Romeo", entrantPrefix: "rr", courts: ["Court 1"], matchMinutes: 30, entrants: 4, place: false, startOffsetMin: 0 },
    ]);
    const [{ id: person }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Cross Division Player') returning id`;
    // Exactly ONE entrant per division — below the >= 2 bar in both.
    for (const d of cup.divisions) {
      const [ent] = await sql<{ id: string }[]>`
        select id from entrants where division_id = ${d.id} order by seed limit 1`;
      await sql`insert into entrant_members (entrant_id, person_id, org_id)
                values (${ent!.id}, ${person}, ${auth.orgId})`;
    }
    // Neither division's own pack can see them — the precondition, asserted so a
    // future change to the per-division builder cannot make this test vacuous.
    for (const d of cup.divisions) {
      const one = await buildSchedulePack(auth, d.id, { now: NOW_W2, mode: "generate", instruction: "x" });
      expect(one.pack.people.map((p) => p.person_id)).not.toContain(person);
    }

    const { pack } = await buildCompetitionPack(
      auth,
      cup.competitionId,
      cup.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const found = pack.people.find((p) => p.person_id === person);
    expect(found).toBeDefined();
    const nameById = new Map(pack.entrants.map((e) => [e.id, e.name]));
    expect(found!.entrant_ids.map((e) => nameById.get(e))).toEqual(["qq-E1", "rr-E1"]);
  }, 60_000);

  it("two builds of an identically seeded competition are byte-identical", async () => {
    const boardA = await seedOrg("pro");
    const boardB = await seedOrg("pro");
    const a = await seedCompetition(boardA.auth, "Twin Cup", BOARD);
    const b = await seedCompetition(boardB.auth, "Twin Cup", BOARD);
    const packA = await buildCompetitionPack(
      boardA.auth,
      a.competitionId,
      [a.divisions[0]!.id, a.divisions[1]!.id],
      { now: NOW_W2, mode: "generate", instruction: "Finish by 6pm." },
    );
    const packB = await buildCompetitionPack(
      boardB.auth,
      b.competitionId,
      [b.divisions[0]!.id, b.divisions[1]!.id],
      { now: NOW_W2, mode: "generate", instruction: "Finish by 6pm." },
    );
    expect(JSON.stringify(redact(packA.pack))).toBe(JSON.stringify(redact(packB.pack)));
    // …and a rebuild of the same board is byte-identical to itself.
    const again = await buildCompetitionPack(
      boardA.auth,
      a.competitionId,
      [a.divisions[0]!.id, a.divisions[1]!.id],
      { now: NOW_W2, mode: "generate", instruction: "Finish by 6pm." },
    );
    expect(JSON.stringify(again.pack)).toBe(JSON.stringify(packA.pack));
  }, 120_000);
});

describe.skipIf(!HAS_DB)("buildCompetitionPack ordering (#350)", () => {
  // M4: since the fix round the division order decides every later division's
  // greedy result, not merely emission order — so a UUID tie-break makes the
  // DRAFT non-reproducible. `createDivision` enforces a unique slug, not a
  // unique name, so same-named divisions are reachable and slug is the stable
  // domain key. Four divisions are seeded in the order d, b, a, c: creation
  // order and id order both differ from slug order.
  it("orders same-named divisions by slug, not by their random ids", async () => {
    const specs: DivSpec[] = ["d", "b", "a", "c"].map((s) => ({
      name: "Same",
      slug: `same-${s}`,
      courts: ["Court 1"],
      matchMinutes: 30,
      entrants: 4,
      place: false,
      startOffsetMin: 0,
    }));
    const orgA = await seedOrg("pro");
    const orgB = await seedOrg("pro");
    const seedA = await seedCompetition(orgA.auth, "Slug Cup", specs);
    const seedB = await seedCompetition(orgB.auth, "Slug Cup", specs);
    const packA = await buildCompetitionPack(
      orgA.auth,
      seedA.competitionId,
      seedA.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const packB = await buildCompetitionPack(
      orgB.auth,
      seedB.competitionId,
      seedB.divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const slugsOf = (
      seed: { divisions: SeededDivision[] },
      pack: { divisions: { id: string }[] },
    ): string[] => pack.divisions.map((d) => seed.divisions.find((s) => s.id === d.id)!.slug);
    expect(slugsOf(seedA, packA.pack)).toEqual(["same-a", "same-b", "same-c", "same-d"]);
    expect(slugsOf(seedB, packB.pack)).toEqual(["same-a", "same-b", "same-c", "same-d"]);
    // …and the whole pack, draft included, is reproducible across the two seeds.
    expect(JSON.stringify(redact(packA.pack))).toBe(JSON.stringify(redact(packB.pack)));
  }, 120_000);
});

describe.skipIf(!HAS_DB)("buildCompetitionPack size limits (#350)", () => {
  it("exports the joint cap as 500", () => {
    expect(COMPETITION_MOVABLE_CAP).toBe(500);
  });

  it("accepts exactly 500 summed movable fixtures", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Cap 500", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 200);
    const { movableIds } = await buildCompetitionPack(auth, comp.id, [a, b], {
      now: NOW_W2,
      mode: "generate",
      instruction: "Pack the day.",
    });
    expect(movableIds.size).toBe(COMPETITION_MOVABLE_CAP);
  }, 120_000);

  // One code, one status. The per-division builder refuses >500 with a 422
  // (schedule-ai.ts) and the joint cap with a 409 — both spelling
  // AI_PLAN_TOO_LARGE — and a joint caller must only ever see the 409.
  //
  // The MECHANISM is the pre-check, not the 422→409 re-throw: a single division
  // over 500 is also over the summed pre-check, so no division is ever built and
  // the re-throw never runs. Asserting that here keeps the title honest — an
  // earlier version of this test named the re-throw while exercising the
  // pre-check, and passed identically with the re-throw deleted.
  it("a division over the per-division cap surfaces the joint 409 from the pre-check", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Cap One Big", visibility: "public", branding: {} });
    const big = await seedBigDivision(auth, comp.id, "Aaa", 501);
    const small = await seedBigDivision(auth, comp.id, "Bbb", 2);
    vi.mocked(buildSchedulePack).mockClear();
    await expect(
      buildCompetitionPack(auth, comp.id, [big, small], { now: NOW_W2, mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AI_PLAN_TOO_LARGE",
      message: "too large — schedule per division",
    });
    expect(vi.mocked(buildSchedulePack)).not.toHaveBeenCalled();
  }, 120_000);

  // M9: the cap must fire before ANY per-division build, not after N greedy
  // solves. Asserted DIRECTLY — the 409 is raised and buildSchedulePack was
  // never called — rather than by piggybacking on another error arriving first.
  // Neither division is individually over the per-division cap, so 300 + 201 is
  // the only thing that can produce this refusal.
  it("refuses an oversized run before building any division's pack", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Precheck", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 201);
    vi.mocked(buildSchedulePack).mockClear();
    await expect(
      buildCompetitionPack(auth, comp.id, [a, b], { now: NOW_W2, mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "AI_PLAN_TOO_LARGE" });
    expect(vi.mocked(buildSchedulePack)).not.toHaveBeenCalled();
  }, 120_000);

  it("over the cap refuses with AI_PLAN_TOO_LARGE", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Cap 501", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 201);
    await expect(
      buildCompetitionPack(auth, comp.id, [a, b], { now: NOW_W2, mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "AI_PLAN_TOO_LARGE" });
  }, 120_000);
});

// ===========================================================================
// W2 (#397) — the joint calendar anchor
// ===========================================================================

describe.skipIf(!HAS_DB)("joint pack calendar anchor (#397)", () => {
  it("resolves ONE clock and ONE window across divisions in different zones", async () => {
    // Under the one-clock decision the ORG zone wins for every division,
    // whatever each division's own tz says (design §2.1).
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(auth, "TZ Cup", BOARD.slice(0, 2));
    await sql`
      update schedule_settings set tz = 'America/New_York'
      where division_id = ${divisions[1]!.id}`;

    const { pack } = await buildCompetitionPack(
      auth,
      competitionId,
      divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );

    expect(pack.tz).toBe(TZ);
    expect(pack.clock.today).toBe("2026-08-07");
    expect(pack.sessionHours).toEqual({ start: "08:00", end: "22:00" });
    // Divisions keep their own tz as a display label…
    expect(pack.divisions.map((d) => d.tz)).toEqual([TZ, "America/New_York"]);
    // …and every instant in the pack is nonetheless written in the org zone.
    for (const d of pack.draft) {
      if (d.scheduled_at !== null) expect(d.scheduled_at).toMatch(/\+01:00$/);
    }
    for (const o of pack.fixtures.obstacles) expect(o.from).toMatch(/\+01:00$/);
    // ONE window for the run, not one per division.
    expect(pack.window.start).toBe("2026-08-01T00:00:00+01:00");
  });

  // The union is a LOCKED decision (#397), and the board above cannot prove it:
  // every division there shares one startAt and one sessionWindows, and every
  // fixture is placed on 2026-08-01, so union, intersection, first and last all
  // return the same instants. This board gives the three divisions genuinely
  // different, non-overlapping date ranges — and leaves their fixtures
  // unplaced, so nothing widens them back together.
  it("takes the UNION of divergent division windows, not any one of them", async () => {
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(
      auth,
      "Union Cup",
      BOARD.map((d) => ({ ...d, place: false })),
    );
    // Widest START is Bravo's; widest END is Charlie's. Neither division owns
    // both, so no single-division answer can pass.
    const ranges = [
      { start: "2026-08-03", end: "2026-08-04" }, // Alpha — built[0]
      { start: "2026-08-01", end: "2026-08-02" }, // Bravo — earliest start
      { start: "2026-08-06", end: "2026-08-09" }, // Charlie — latest end
    ];
    for (const [i, d] of divisions.entries()) {
      const r = ranges[i]!;
      await sql`update schedule_settings set config = ${sql.json({
        ...settingsConfig(BOARD[i]!.courts, BOARD[i]!.matchMinutes),
        startAt: `${r.start}T09:00:00.000Z`,
        endAt: `${r.end}T18:00:00.000Z`,
        sessionWindows: [{ from: `${r.start}T09:00:00.000Z`, to: `${r.start}T18:00:00.000Z` }],
      })} where division_id = ${d.id}`;
    }

    const { pack } = await buildCompetitionPack(
      auth,
      competitionId,
      divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );

    expect(pack.window.start).toBe("2026-08-01T00:00:00+01:00"); // Bravo's day
    expect(pack.window.end).toBe("2026-08-09T23:59:59+01:00"); // Charlie's day
    // Explicitly not any single division's window, and not the intersection —
    // both of which the previous fixture would have satisfied.
    for (const [i, d] of divisions.entries()) {
      const r = ranges[i]!;
      const own = { start: `${r.start}T00:00:00+01:00`, end: `${r.end}T23:59:59+01:00` };
      expect(`${own.start}..${own.end}`, `${d.name} must not own the joint window`).not.toBe(
        `${pack.window.start}..${pack.window.end}`,
      );
    }
  });

  // `draftPlaced` is what J5 tells the model to read as "this division is
  // already drafted". Since #397 a repair draft can carry `scheduled_at: null`
  // — a sentinel the pack refused to pass off as a time — so counting rows
  // rather than PLACEMENTS reports a division as fully drafted when not one of
  // its fixtures holds a real slot.
  it("counts only PLACED rows in draftPlaced when a board is all sentinels", async () => {
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(auth, "Sentinel Cup", BOARD.slice(0, 2));
    // Alpha's whole board predates 1971; Bravo's is untouched.
    await sql`update fixtures set scheduled_at = '1970-01-01T00:00:00Z'
              where division_id = ${divisions[0]!.id}`;

    const { pack } = await buildCompetitionPack(
      auth,
      competitionId,
      divisions.map((d) => d.id),
      { now: NOW_W2, mode: "repair", instruction: "x" },
    );

    const alpha = pack.divisions.find((d) => d.name === "Alpha")!;
    const bravo = pack.divisions.find((d) => d.name === "Bravo")!;
    expect(alpha.draftPlaced).toBe(0);
    expect(bravo.draftPlaced).toBeGreaterThan(0);
    // The rows are still THERE — nulled, not dropped — so the model is told the
    // fixtures exist and are unplaced rather than being told nothing at all.
    const alphaRows = pack.draft.filter((d) => alpha.movableIds.includes(d.fixture_id));
    expect(alphaRows.length).toBeGreaterThan(0);
    expect(alphaRows.every((d) => d.scheduled_at === null)).toBe(true);
  });

  it("spans the window across every selected division's board", async () => {
    // Bravo starts four hours after Alpha and Charlie eight; the window is the
    // union, so no division is asked to fit inside another's day.
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(auth, "Span Cup", BOARD);
    const { pack } = await buildCompetitionPack(
      auth,
      competitionId,
      divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const startMs = Date.parse(pack.window.start);
    const endMs = Date.parse(pack.window.end);
    for (const d of pack.draft) {
      if (d.scheduled_at === null) continue;
      expect(Date.parse(d.scheduled_at)).toBeGreaterThanOrEqual(startMs);
      expect(Date.parse(d.scheduled_at)).toBeLessThanOrEqual(endMs);
    }
  });

  it("verifies every division against the SHARED window", async () => {
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(auth, "Win Cup", BOARD.slice(0, 2));
    const { pack } = await buildCompetitionPack(
      auth,
      competitionId,
      divisions.map((d) => d.id),
      { now: NOW_W2, mode: "generate", instruction: "x" },
    );
    const target = pack.fixtures.movable[0]!;
    const conflicts = verifyJoint(
      {
        assignments: [
          {
            fixture_id: target.id,
            scheduled_at: "2027-03-01T10:00:00+00:00",
            court_label: pack.courts[0]!,
          },
        ],
        unschedulable: [],
        summary: "",
        assumptions: [],
      } as unknown as Parameters<typeof verifyJoint>[0],
      pack,
    );
    const windowed = conflicts.filter((c) => c.reason === "window");
    expect(windowed).toHaveLength(1);
    expect(windowed[0]!.fixtureId).toBe(target.id);
    // #399: outside the days the competition runs is not a preference, so the
    // plan-time taxonomy blocks it. Whether it can be WRITTEN is the delta at
    // the apply gate — a board already outside its window stays editable.
    expect(windowed.every(isBlocking)).toBe(true);
  });

  it("is byte-identical for two joint builds at the same injected instant", async () => {
    const { auth } = await seedOrg("pro");
    const { competitionId, divisions } = await seedCompetition(auth, "Det Cup", BOARD.slice(0, 2));
    const ids = divisions.map((d) => d.id);
    const a = await buildCompetitionPack(auth, competitionId, ids, {
      now: NOW_W2, mode: "generate", instruction: "x",
    });
    const b = await buildCompetitionPack(auth, competitionId, ids, {
      now: NOW_W2, mode: "generate", instruction: "x",
    });
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
  });
});

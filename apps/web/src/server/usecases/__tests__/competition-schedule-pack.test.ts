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
import { buildCompetitionPack, COMPETITION_MOVABLE_CAP } from "../competition-schedule-ai";
import { buildSchedulePack, OTHER_DIVISION_LABEL } from "../schedule-ai";
import { seedOrg } from "./_seed";

// A pass-through spy over the real implementation — it changes no behaviour and
// exists so the cap pre-check can assert directly that NO per-division build
// ran, instead of piggybacking on some other error arriving first.
vi.mock("../schedule-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai")>();
  return { ...actual, buildSchedulePack: vi.fn(actual.buildSchedulePack) };
});

const HAS_DB = !!process.env.DATABASE_URL;

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
  const comp = await createCompetition(auth, { name: compName, visibility: "public", branding: {} });
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
      mode: "generate",
      instruction: "x",
    });
    expect(pack.courts).toEqual(["Court 1", "Court 2", "Court 3"]);
  }, 60_000);

  it("divergentCourts names the labels that are not in every division", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
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
      { mode: "generate", instruction: "x" },
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
      { mode: "generate", instruction: "x" },
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
      const from = Date.parse(a.scheduled_at);
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
      { mode: "generate", instruction: "x" },
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
      const from = Date.parse(a.scheduled_at);
      const to = from + minutes.get(a.division_id)! * MIN;
      if (from < T0 + 30 * MIN && T0 < to) {
        overlaps.push(`${a.fixture_id} @ ${new Date(from).toISOString()}`);
      }
    }
    expect(overlaps).toEqual([]);
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
      { mode: "generate", instruction: "x" },
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
      mode: "generate",
      instruction: "x",
    });
    for (const d of roomy.pack.divisions) expect(d.draftPlaced).toBe(d.movableIds.length);
  }, 60_000);

  it("merges a shared person's entrant ids in global name order", async () => {
    // M10: entrant-id arrays order on the entrant NAME (schedule-ai.ts:622-630).
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
      { mode: "generate", instruction: "x" },
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

  it("two builds of an identically seeded competition are byte-identical", async () => {
    const boardA = await seedOrg("pro");
    const boardB = await seedOrg("pro");
    const a = await seedCompetition(boardA.auth, "Twin Cup", BOARD);
    const b = await seedCompetition(boardB.auth, "Twin Cup", BOARD);
    const packA = await buildCompetitionPack(
      boardA.auth,
      a.competitionId,
      [a.divisions[0]!.id, a.divisions[1]!.id],
      { mode: "generate", instruction: "Finish by 6pm." },
    );
    const packB = await buildCompetitionPack(
      boardB.auth,
      b.competitionId,
      [b.divisions[0]!.id, b.divisions[1]!.id],
      { mode: "generate", instruction: "Finish by 6pm." },
    );
    expect(JSON.stringify(redact(packA.pack))).toBe(JSON.stringify(redact(packB.pack)));
    // …and a rebuild of the same board is byte-identical to itself.
    const again = await buildCompetitionPack(
      boardA.auth,
      a.competitionId,
      [a.divisions[0]!.id, a.divisions[1]!.id],
      { mode: "generate", instruction: "Finish by 6pm." },
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
      { mode: "generate", instruction: "x" },
    );
    const packB = await buildCompetitionPack(
      orgB.auth,
      seedB.competitionId,
      seedB.divisions.map((d) => d.id),
      { mode: "generate", instruction: "x" },
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
    const comp = await createCompetition(auth, { name: "Cap 500", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 200);
    const { movableIds } = await buildCompetitionPack(auth, comp.id, [a, b], {
      mode: "generate",
      instruction: "Pack the day.",
    });
    expect(movableIds.size).toBe(COMPETITION_MOVABLE_CAP);
  }, 120_000);

  // One code, one status. The per-division builder refuses >500 with a 422
  // (schedule-ai.ts:293) and the joint sum cap with a 409 — both spelling the
  // code AI_PLAN_TOO_LARGE. Inside a joint call the caller must see exactly one
  // contract, or the endpoint cannot present it coherently. "Aaa" sorts before
  // "Bbb", so the oversized division is the FIRST one built and its 422 is what
  // would otherwise escape.
  it("a division over the per-division cap inside a joint call is the joint 409, not a 422", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { name: "Cap One Big", visibility: "public", branding: {} });
    const big = await seedBigDivision(auth, comp.id, "Aaa", 501);
    const small = await seedBigDivision(auth, comp.id, "Bbb", 2);
    await expect(
      buildCompetitionPack(auth, comp.id, [big, small], { mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AI_PLAN_TOO_LARGE",
      message: "too large — schedule per division",
    });
  }, 120_000);

  // M9: the cap must fire before ANY per-division build, not after N greedy
  // solves. Asserted DIRECTLY — the 409 is raised and buildSchedulePack was
  // never called — rather than by piggybacking on another error arriving first.
  // Neither division is individually over the per-division cap, so 300 + 201 is
  // the only thing that can produce this refusal.
  it("refuses an oversized run before building any division's pack", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { name: "Precheck", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 201);
    vi.mocked(buildSchedulePack).mockClear();
    await expect(
      buildCompetitionPack(auth, comp.id, [a, b], { mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "AI_PLAN_TOO_LARGE" });
    expect(vi.mocked(buildSchedulePack)).not.toHaveBeenCalled();
  }, 120_000);

  it("over the cap refuses with AI_PLAN_TOO_LARGE", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { name: "Cap 501", visibility: "public", branding: {} });
    const a = await seedBigDivision(auth, comp.id, "Aaa", 300);
    const b = await seedBigDivision(auth, comp.id, "Bbb", 201);
    await expect(
      buildCompetitionPack(auth, comp.id, [a, b], { mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "AI_PLAN_TOO_LARGE" });
  }, 120_000);
});

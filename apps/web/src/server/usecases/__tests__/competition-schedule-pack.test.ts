// #350 Task 1 — buildCompetitionPack acceptance. One competition, several
// divisions, one joint pack: every fixture/obstacle/assignment carries the
// division it belongs to, courts are unioned (and divergence named), each
// division keeps its OWN settings, a selected division never appears as its own
// obstacle, and the whole thing is byte-for-byte deterministic.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { buildCompetitionPack, COMPETITION_MOVABLE_CAP } from "../competition-schedule-ai";
import { OTHER_DIVISION_LABEL } from "../schedule-ai";
import { seedOrg } from "./_seed";

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

function settingsConfig(courts: string[], matchMinutes: number) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }],
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
  courts: string[];
  matchMinutes: number;
  /** Round-robin entrant count; 4 → 6 fixtures. */
  entrants: number;
  /** Persist a court/time on every fixture (the placements the joint pack must
   *  NOT re-serve as obstacles for a selected division). */
  place: boolean;
  /** Minutes past T0 the first fixture lands on. */
  startOffsetMin: number;
}

interface SeededDivision {
  id: string;
  name: string;
  fixtureCount: number;
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
    const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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
        display_name: `${spec.name}-E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${division.id}, ${sql.json(settingsConfig(spec.courts, spec.matchMinutes))}, ${TZ}, now())
      on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    if (spec.place) {
      const ordered = [...fixtures].sort(
        (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
      );
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
    }
    divisions.push({ id: division.id, name: spec.name, fixtureCount: fixtures.length });
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

  it("a selected division's fixtures never appear as obstacles", async () => {
    const { pack } = await buildCompetitionPack(auth, competitionId, selected(), {
      mode: "generate",
      instruction: "x",
    });
    // Every selected fixture is currently placed by the seed; its (court, start)
    // must not be re-served as an obstacle by the sibling division's pack.
    const occupied = new Set(
      pack.fixtures.movable
        .filter((f) => f.current.at !== null && f.current.court !== null)
        .map((f) => `${f.current.court}|${Date.parse(f.current.at!)}`),
    );
    expect(occupied.size).toBe(RR * 2);
    for (const o of pack.fixtures.obstacles) {
      expect(occupied.has(`${o.court}|${Date.parse(o.from)}`)).toBe(false);
    }
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

// #396 review fix 2 — `buildCompetitionPack` hands every division's greedy pass
// two lists of already-taken slots: `fixedOccupancy` (the run's own immovable
// board) and `drafted` (what the divisions before it just took). Each division's
// greedy pass keys its OWN fixtures on its OWN person map, which is raw unless
// that division collapsed something internally. So a list that carries only the
// RUN-WIDE guarded key stops matching a raw id on the other side, and deletes a
// constraint that fired before #396 instead of adding one.
//
// `fixedOccupancy` therefore emits raw AND guarded. Reducing it to
// `.map(identity.keyOf)` survived the whole suite until this file existed — the
// code comment claiming the trap "was caught twice" was itself unprotected.
//
// THE BOARD (fix 2):
//
//   Alpha   (Court 2)  move  : A-1 vs A-2            ← movable, holds Cody(1)
//   Bravo   (Court 1)  fixed : B-1 vs B-2 @ 09:00Z   ← 'finalized', holds Cody(1)
//                      spare : B-3 vs B-4            ← movable, holds Cody(2)
//
// `Cody(1)` is ONE `persons` row, rostered in Alpha and in Bravo's fixed
// fixture. `Cody(2)` is a second row of the same normalised name, and it sits in
// BRAVO — never in Alpha. That placement is the whole point: the run-wide
// resolver sees both rows and collapses `Cody(1)`, while Alpha's own resolver
// sees only one "Cody Vale" and keeps the raw uuid. Alpha's greedy pass is then
// comparing a raw id against whatever `fixedOccupancy` emits.
//
// Alpha owns only Court 2 and the fixed fixture sits on Court 1, so no court
// rule can separate them; they are in different divisions, so no entrant rule
// can either.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { buildCompetitionPack } from "../competition-schedule-ai";
import { buildSchedulePack } from "../schedule-ai";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const TZ = "Europe/London";
const MIN = 60_000;
const FIXED_FROM = Date.parse("2026-08-01T09:00:00.000Z");
const FIXED_TO = FIXED_FROM + 30 * MIN;

function settingsConfig(courts: string[]) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T18:00:00.000Z" }],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "balance",
      parallelism: "mixed",
      crossPersonClash: "hard",
    },
  };
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  slug: string,
  courts: string[],
  entrantNames: string[],
): Promise<{ id: string; entrantByName: Map<string, string>; stageId: string }> {
  const division = await createDivision(auth, competitionId, {
    name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "KO",
    config: {},
  });
  return {
    id: division.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
    stageId: stage!.id,
  };
}

async function addPerson(orgId: string, fullName: string, entrantIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  for (const e of entrantIds) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${e}, ${p!.id}, ${orgId})`;
  }
  return p!.id;
}

async function movableFixture(
  auth: AuthCtx,
  d: { id: string; stageId: string; entrantByName: Map<string, string> },
  extKey: string,
  seq: number,
  home: string,
  away: string,
): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, ${seq}, ${extKey}, 'scheduled',
            ${d.entrantByName.get(home)!}, ${d.entrantByName.get(away)!})
    returning id`;
  return f!.id;
}

const overlaps = (aFrom: number, aTo: number, bFrom: number, bTo: number): boolean =>
  aFrom < bTo && bFrom < aTo;

/** The fix-2 board drawn at the top of this file. */
async function seedFixedOccupancyBoard(): Promise<{
  auth: AuthCtx;
  competitionId: string;
  alphaId: string;
  bravoId: string;
  codyId: string;
  moveId: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Fixed Occupancy ${tag}`,
    visibility: "public",
    branding: {},
  });
  // Built in NAME order, so Alpha drafts first and sees Bravo's fixed board.
  const alpha = await makeDivision(auth, comp.id, "Alpha", `alpha-${tag}`, ["Court 2"], [
    "A-1",
    "A-2",
  ]);
  const bravo = await makeDivision(auth, comp.id, "Bravo", `bravo-${tag}`, ["Court 1"], [
    "B-1",
    "B-2",
    "B-3",
    "B-4",
  ]);

  const cody = await addPerson(auth.orgId, "Cody Vale", [
    alpha.entrantByName.get("A-1")!,
    bravo.entrantByName.get("B-1")!,
  ]);
  // The same-named twin lives in BRAVO, never in Alpha — so only the run-wide
  // resolver can see the pair.
  await addPerson(auth.orgId, "cody  vale", [bravo.entrantByName.get("B-3")!]);
  await addPerson(auth.orgId, "Solo A-2", [alpha.entrantByName.get("A-2")!]);
  await addPerson(auth.orgId, "Solo B-2", [bravo.entrantByName.get("B-2")!]);
  await addPerson(auth.orgId, "Solo B-4", [bravo.entrantByName.get("B-4")!]);

  const moveId = await movableFixture(auth, alpha, "move", 0, "A-1", "A-2");
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_label)
    values (${bravo.stageId}, ${bravo.id}, ${auth.orgId}, 1, 0, 'fixed', 'finalized',
            ${bravo.entrantByName.get("B-1")!}, ${bravo.entrantByName.get("B-2")!},
            ${new Date(FIXED_FROM).toISOString()}, 'Court 1')`;
  await movableFixture(auth, bravo, "spare", 1, "B-3", "B-4");

  return { auth, competitionId: comp.id, alphaId: alpha.id, bravoId: bravo.id, codyId: cody, moveId };
}

/**
 * The fix-6 board — the SECOND `existing` list, `drafted`.
 *
 *   Alpha    (Court 1)  a-move : A-1 vs A-2   ← drafted FIRST, holds Erin(1)
 *   Bravo    (Court 2)  b-move : B-1 vs B-2   ← drafted SECOND, holds Erin(1)
 *   Charlie  (Court 3)  c-move : C-1 vs C-2   ← holds Erin(2)
 *
 * No fixed fixtures anywhere, so `fixedOccupancy` is empty and the feed-forward
 * list is the only thing that can link Alpha's slot to Bravo's. `Erin(1)` is one
 * row in Alpha AND Bravo; `Erin(2)` is a same-named row parked in CHARLIE, so
 * neither Alpha nor Bravo collapses on its own while the run-wide resolver does.
 * Bravo's greedy pass therefore compares a raw uuid against whatever Alpha's
 * drafted slot carries.
 */
async function seedFeedForwardBoard(): Promise<{
  auth: AuthCtx;
  competitionId: string;
  divisionIds: string[];
  erinId: string;
  aMoveId: string;
  bMoveId: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Feed Forward ${tag}`,
    visibility: "public",
    branding: {},
  });
  const alpha = await makeDivision(auth, comp.id, "Alpha", `alpha-${tag}`, ["Court 1"], ["A-1", "A-2"]);
  const bravo = await makeDivision(auth, comp.id, "Bravo", `bravo-${tag}`, ["Court 2"], ["B-1", "B-2"]);
  const charlie = await makeDivision(auth, comp.id, "Charlie", `charlie-${tag}`, ["Court 3"], [
    "C-1",
    "C-2",
  ]);

  const erin = await addPerson(auth.orgId, "Erin Vale", [
    alpha.entrantByName.get("A-1")!,
    bravo.entrantByName.get("B-1")!,
  ]);
  await addPerson(auth.orgId, "erin  vale", [charlie.entrantByName.get("C-1")!]);
  await addPerson(auth.orgId, "Solo A-2", [alpha.entrantByName.get("A-2")!]);
  await addPerson(auth.orgId, "Solo B-2", [bravo.entrantByName.get("B-2")!]);
  await addPerson(auth.orgId, "Solo C-2", [charlie.entrantByName.get("C-2")!]);

  const aMoveId = await movableFixture(auth, alpha, "a-move", 0, "A-1", "A-2");
  const bMoveId = await movableFixture(auth, bravo, "b-move", 0, "B-1", "B-2");
  await movableFixture(auth, charlie, "c-move", 0, "C-1", "C-2");

  return {
    auth,
    competitionId: comp.id,
    divisionIds: [alpha.id, bravo.id, charlie.id],
    erinId: erin,
    aMoveId,
    bMoveId,
  };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the joint pass's `existing` lists are raw AND guarded (#396)", () => {
  it("FIXED OCCUPANCY: a run-wide collapse never costs a division its raw-id match", async () => {
    const board = await seedFixedOccupancyBoard();

    // Guards the guard, both halves of the premise:
    //  (a) Alpha ALONE does not collapse — its greedy pass compares a raw uuid.
    const solo = await buildSchedulePack(board.auth, board.alphaId, {
      mode: "generate",
      instruction: "One round.",
    });
    expect(solo.pack.participants[board.moveId]).toContain(board.codyId);
    expect(solo.pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(false);

    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      [board.alphaId, board.bravoId],
      { mode: "generate", instruction: "One round each." },
    );
    //  (b) …while the RUN-WIDE resolver does collapse the pair.
    expect(pack.participants[board.moveId]).toContain("name:cody vale");
    expect(pack.assumptions).toContain(
      "'Cody Vale' matches 2 person records by name — " +
        "treated as one player for scheduling only; no records were merged",
    );
    // Disjoint courts, so no court rule can separate the two fixtures.
    const courtsOf = (id: string): string[] =>
      pack.divisions.find((d) => d.id === id)!.settings.courts;
    expect(courtsOf(board.alphaId)).toEqual(["Court 2"]);
    expect(courtsOf(board.bravoId)).toEqual(["Court 1"]);

    const a = pack.draft.find((d) => d.fixture_id === board.moveId);
    expect(a, "joint draft is missing Alpha's movable fixture").toBeDefined();
    const from = Date.parse(a!.scheduled_at);
    const to = from + 30 * MIN;
    expect(
      overlaps(from, to, FIXED_FROM, FIXED_TO),
      `Alpha's fixture was drafted at ${new Date(from).toISOString()} on ${a!.court_label}, ` +
        `on top of Bravo's fixed 09:00Z slot — both hold person ${board.codyId}, whose raw ` +
        "id is what Alpha's own greedy pass compares against",
    ).toBe(false);
  }, 180_000);

  it("FEED-FORWARD: a division drafted earlier hands on its raw people, not only the run key", async () => {
    const board = await seedFeedForwardBoard();

    // Guards the guard: neither Alpha nor Bravo collapses on its own, so both
    // key their own fixtures on the RAW person uuid.
    for (const [divisionId, fixtureId] of [
      [board.divisionIds[0]!, board.aMoveId],
      [board.divisionIds[1]!, board.bMoveId],
    ] as const) {
      const solo = await buildSchedulePack(board.auth, divisionId, {
        mode: "generate",
        instruction: "One round.",
      });
      expect(solo.pack.participants[fixtureId]).toContain(board.erinId);
      expect(solo.pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(false);
    }

    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      board.divisionIds,
      { mode: "generate", instruction: "One round each." },
    );
    // …while the run-wide resolver collapses the pair, which is what the
    // feed-forward list carried — and only that — before this fix.
    expect(pack.participants[board.aMoveId]).toContain("name:erin vale");
    expect(pack.participants[board.aMoveId]).not.toContain(board.erinId);
    // Nothing is fixed on this board, so `fixedOccupancy` cannot be the link…
    expect(pack.fixtures.obstacles).toEqual([]);
    // …and every division owns its own court, so no court rule can be either.
    expect(pack.divergentCourts.sort()).toEqual(["Court 1", "Court 2", "Court 3"]);

    const slot = (id: string): { from: number; to: number; court: string } => {
      const a = pack.draft.find((d) => d.fixture_id === id);
      expect(a, `joint draft is missing fixture ${id}`).toBeDefined();
      const from = Date.parse(a!.scheduled_at);
      return { from, to: from + 30 * MIN, court: a!.court_label };
    };
    const first = slot(board.aMoveId);
    const second = slot(board.bMoveId);
    expect(
      overlaps(first.from, first.to, second.from, second.to),
      `Alpha's fixture (${new Date(first.from).toISOString()} ${first.court}) overlaps Bravo's ` +
        `(${new Date(second.from).toISOString()} ${second.court}) — both hold person ` +
        `${board.erinId}, and Bravo's greedy pass only ever sees that raw id`,
    ).toBe(false);
  }, 240_000);
});

// #396 review fixes 1 and 4 — the two lists the single-division greedy pass is
// handed as `existing` must carry the SAME person keys its own fixtures carry.
//
// `buildSchedulePack` runs every entrant roster through the scheduling-only
// same-name guard (`personKeyResolver`) before the participant recursion, so a
// movable fixture's `people` are GUARDED keys. Any `existing` entry that still
// carries a raw person UUID therefore stops matching the moment the guard
// collapses that person — which silently DELETES a constraint that fired before
// #396 rather than adding one. The guard may only ever add.
//
// Two lists, two boards:
//
//   SIBLINGS (fix 1)   `siblingAssignments` returns raw person ids straight from
//                      `peopleByEntrant`. The board below puts ONE person row in
//                      this division AND in a sibling division's already-placed
//                      fixture, then adds a second, same-named person row inside
//                      this division so the guard collapses the pair.
//
//   OBSTACLES (fix 4)  `obstacleAssignments` maps this division's own fixed
//                      fixtures. Here the collapsed pair straddles the movable
//                      fixture and the fixed one, so a raw map on the obstacle
//                      side cannot see the clash at all.
//
// Both boards keep the clashing pair on DIFFERENT courts, so no court rule can
// separate them, and in different entrants, so no entrant rule can either — the
// person keys are the only link.
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
import { buildSchedulePack, OTHER_DIVISION_LABEL } from "../schedule-ai";
import { seedOrg } from "./_seed";

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

const TZ = "Europe/London";
const MIN = 60_000;
/** The instant the already-placed fixture occupies, on every board here. */
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
      // A person double-booking rejects the placement outright, so the placer
      // direction is a hard assertion rather than a warning count.
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

const overlaps = (aFrom: number, aTo: number, bFrom: number, bTo: number): boolean =>
  aFrom < bTo && bFrom < aTo;

/**
 * FIX 1 board — the collapsed person is committed in a SIBLING division.
 *
 *   Planned  (Court 2)   move   : P-A vs P-B          ← movable, holds Dana(1)
 *                        twin   : P-C vs P-D          ← movable, holds Dana(2)
 *   Sibling  (Court 1)   fixed  : S-1 vs S-2 @ 09:00Z ← already placed, holds Dana(1)
 *
 * `Dana(1)` and `Dana(2)` are two `persons` rows with the same normalised name,
 * both in the PLANNED division, so its own guard collapses them to
 * `name:dana vale`. `Dana(1)` is the very same row rostered into the sibling's
 * fixed fixture, so before #396 the raw id on both sides matched and the placer
 * refused 09:00Z. Emitting only the guarded key on the movable side while the
 * sibling list stays raw loses that match.
 */
async function seedSiblingCollapseBoard(): Promise<{
  auth: AuthCtx;
  plannedId: string;
  danaId: string;
  moveId: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Sibling Collapse ${tag}`,
    visibility: "public",
    branding: {},
  });
  const planned = await makeDivision(auth, comp.id, "Planned", `planned-${tag}`, ["Court 2"], [
    "P-A",
    "P-B",
    "P-C",
    "P-D",
  ]);
  const sibling = await makeDivision(auth, comp.id, "Sibling", `sibling-${tag}`, ["Court 1"], [
    "S-1",
    "S-2",
  ]);

  // ONE row, in the planned division AND in the sibling's fixed fixture…
  const dana = await addPerson(auth.orgId, "Dana Vale", [
    planned.entrantByName.get("P-A")!,
    sibling.entrantByName.get("S-1")!,
  ]);
  // …and its same-named twin, inside the planned division, which is what makes
  // the planned division's own guard collapse `dana` to a synthetic key.
  await addPerson(auth.orgId, "dana  vale", [planned.entrantByName.get("P-C")!]);
  await addPerson(auth.orgId, "Solo P-B", [planned.entrantByName.get("P-B")!]);
  await addPerson(auth.orgId, "Solo P-D", [planned.entrantByName.get("P-D")!]);
  await addPerson(auth.orgId, "Solo S-2", [sibling.entrantByName.get("S-2")!]);

  const [move] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${planned.stageId}, ${planned.id}, ${auth.orgId}, 1, 0, 'move', 'scheduled',
            ${planned.entrantByName.get("P-A")!}, ${planned.entrantByName.get("P-B")!})
    returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${planned.stageId}, ${planned.id}, ${auth.orgId}, 1, 1, 'twin', 'scheduled',
            ${planned.entrantByName.get("P-C")!}, ${planned.entrantByName.get("P-D")!})`;
  // The sibling's board is already fixed court time.
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_label)
    values (${sibling.stageId}, ${sibling.id}, ${auth.orgId}, 1, 0, 'fixed', 'finalized',
            ${sibling.entrantByName.get("S-1")!}, ${sibling.entrantByName.get("S-2")!},
            ${new Date(FIXED_FROM).toISOString()}, 'Court 1')`;

  return { auth, plannedId: planned.id, danaId: dana, moveId: move!.id };
}

/**
 * FIX 4 board — the collapsed pair straddles this division's OWN fixed fixture.
 *
 *   Only division (Court 1, Court 2)
 *     fixed : O-3 vs O-4 @ 09:00Z Court 1  ← 'finalized', holds Rory(2)
 *     move  : O-1 vs O-2                   ← movable, holds Rory(1)
 *
 * `obstacleAssignments` maps the fixed row. Given the RAW person map it emits
 * `Rory(2)`'s uuid, which no longer matches the movable fixture's collapsed
 * `name:rory quist` — and the placer drops the fixed fixture onto Court 2 at the
 * same instant.
 */
async function seedObstacleCollapseBoard(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  moveId: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Obstacle Collapse ${tag}`,
    visibility: "public",
    branding: {},
  });
  const only = await makeDivision(auth, comp.id, "Only", `only-${tag}`, ["Court 1", "Court 2"], [
    "O-1",
    "O-2",
    "O-3",
    "O-4",
  ]);
  await addPerson(auth.orgId, "Rory Quist", [only.entrantByName.get("O-1")!]);
  await addPerson(auth.orgId, "rory  quist", [only.entrantByName.get("O-3")!]);
  await addPerson(auth.orgId, "Solo O-2", [only.entrantByName.get("O-2")!]);
  await addPerson(auth.orgId, "Solo O-4", [only.entrantByName.get("O-4")!]);

  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_label)
    values (${only.stageId}, ${only.id}, ${auth.orgId}, 1, 0, 'fixed', 'finalized',
            ${only.entrantByName.get("O-3")!}, ${only.entrantByName.get("O-4")!},
            ${new Date(FIXED_FROM).toISOString()}, 'Court 1')`;
  const [move] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${only.stageId}, ${only.id}, ${auth.orgId}, 1, 1, 'move', 'scheduled',
            ${only.entrantByName.get("O-1")!}, ${only.entrantByName.get("O-2")!})
    returning id`;
  return { auth, divisionId: only.id, moveId: move!.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the greedy pass's `existing` list is guarded too (#396)", () => {
  it("SIBLINGS: a collapsed person already committed in a sibling division still blocks the slot", async () => {
    const { auth, plannedId, danaId, moveId } = await seedSiblingCollapseBoard();
    const { pack } = await buildSchedulePack(auth, plannedId, {
      now: NOW_W2,
      mode: "generate",
      instruction: "One round.",
    });

    // Guards the guard. The planned division really did collapse the pair…
    expect(pack.participants[moveId]).toContain("name:dana vale");
    expect(pack.participants[moveId]).not.toContain(danaId);
    expect(pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(true);
    // …the sibling's fixture really is on the board as fixed occupancy…
    const sib = pack.fixtures.obstacles.filter((o) => o.label === OTHER_DIVISION_LABEL);
    expect(sib).toHaveLength(1);
    expect(Date.parse(sib[0]!.from)).toBe(FIXED_FROM);
    // …and on a court this division cannot even use, so no court rule applies.
    expect(pack.settings.courts).toEqual(["Court 2"]);
    expect(sib[0]!.court).toBe("Court 1");

    const a = pack.draft.find((d) => d.fixture_id === moveId);
    expect(a, "draft is missing the movable fixture").toBeDefined();
    const from = Date.parse(a!.scheduled_at!);
    const to = from + pack.settings.matchMinutes * MIN;
    expect(
      overlaps(from, to, FIXED_FROM, FIXED_TO),
      `the movable fixture was drafted at ${new Date(from).toISOString()} on ${a!.court_label}, ` +
        `on top of the sibling division's fixed 09:00Z slot — they share person ${danaId}, ` +
        "whose raw id is all siblingAssignments emits",
    ).toBe(false);
  }, 120_000);

  it("OBSTACLES: a collapsed person on this division's own fixed fixture still blocks the slot", async () => {
    const { auth, divisionId, moveId } = await seedObstacleCollapseBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate",
      instruction: "One round.",
    });

    // Guards the guard: the collapse happened, and the fixed fixture is an
    // obstacle on a DIFFERENT court from the one left free at 09:00Z.
    expect(pack.participants[moveId]).toContain("name:rory quist");
    const fixed = pack.fixtures.obstacles.filter((o) => o.label !== OTHER_DIVISION_LABEL);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.court).toBe("Court 1");
    expect(pack.settings.courts).toEqual(["Court 1", "Court 2"]);

    const a = pack.draft.find((d) => d.fixture_id === moveId);
    expect(a, "draft is missing the movable fixture").toBeDefined();
    const from = Date.parse(a!.scheduled_at!);
    const to = from + pack.settings.matchMinutes * MIN;
    expect(
      overlaps(from, to, FIXED_FROM, FIXED_TO),
      `the movable fixture was drafted at ${new Date(from).toISOString()} on ${a!.court_label}, ` +
        `on top of this division's own fixed 09:00Z slot — the two hold one collapsed player`,
    ).toBe(false);
  }, 120_000);
});

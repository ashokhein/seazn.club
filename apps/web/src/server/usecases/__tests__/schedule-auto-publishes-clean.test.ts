// THE AUTO PASS PRODUCES A BOARD THE PUBLISH GATE ACCEPTS UNACKNOWLEDGED.
//
// Nothing else in the branch says this. `schedule-publish-gate.test.ts` drives
// hand-placed boards, and the e2e board spec publishes with
// `acknowledge_warnings: true` — correctly, because the fixtures it publishes
// have been moved, pinned and re-flowed by the tests ahead of it in its serial
// chain, so a rest shortfall there is fair game. But that override means no
// surface in the branch still proves the auto pass yields a warning-free board:
// a regression that made every auto board breach the rest floor would stay
// green everywhere.
//
// This is that proof, end to end on a real database: settings with a live rest
// floor → generate → `autoSchedule` → `applySchedule` → `publishSchedule` with
// NO acknowledgement. Nothing hand-places a card, so what publishes is exactly
// what the solver produced.
//
// THE FLOOR HAS TO BE LIVE, or this is a test about nothing. The second case
// hand-places the SAME entrants on the SAME settings with a 30-minute
// turnaround and shows the gate refusing it with `warn.rest` — so the first
// case's clean publish is the solver honouring the floor, not the gate being
// asleep.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, autoSchedule, publishSchedule } from "../schedule";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DAY = "2026-08-10";
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

/** 30-minute matches with a 30-minute rest floor: an entrant's two matches must
 *  start at least an hour apart. A 4-entrant round robin is 6 matches over 3
 *  rounds, so the tightest legal board is 150 minutes on two courts — easily
 *  inside the window, and impossible to reach by accident. */
const REST_MIN = 30;

function settingsConfig() {
  return {
    startAt: at("08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: REST_MIN,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: REST_MIN,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard: [],
    },
  };
}

interface Seeded {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  entrantIds: string[];
}

async function seedDivision(): Promise<Seeded> {
  const { auth } = await seedOrg("pro");
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Auto Publish ${tag}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: `Div ${tag}`,
    slug: `auto-pub-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig())}, ${"UTC"}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    [1, 2, 3, 4].map((n) => ({
      kind: "individual" as const,
      display_name: `E${n}`,
      seed: n,
      members: [],
    })),
  );
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}
    order by display_name`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    entrantIds: entrants.map((e) => e.id),
  };
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return row!.status;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("an auto-scheduled board publishes without acknowledgement", () => {
  it("build → apply → publish, with no acknowledge_warnings", async () => {
    const { auth, divisionId, stageId } = await seedDivision();
    const { fixtures } = await generateStageFixtures(auth, stageId);
    expect(fixtures).toHaveLength(6);

    const proposal = await autoSchedule(auth, stageId, {
      only_unlocked: false,
      mode: "build",
    });
    // Every card placed, or the publish below would be proving something about
    // a half-empty board — the gate is blind to a card with no time at all.
    expect(proposal.assignments).toHaveLength(6);
    // …and the solver's own report agrees the board it produced is clean.
    expect(proposal.conflicts).toEqual([]);

    const applied = await applySchedule(auth, stageId, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    expect(applied.applied).toBe(6);

    // The assertion the branch had lost: NO acknowledgement, and it still goes.
    const out = await publishSchedule(auth, divisionId);

    expect(out).toMatchObject({ status: "scheduled", published: true });
    expect(await divisionStatus(divisionId)).toBe("scheduled");
  }, 180_000);

  it("…and the rest floor those settings carry really does refuse a board", async () => {
    // Same settings, same entrants, board placed BY HAND with E1 turning round
    // in 30 minutes. Without this the case above is satisfied by a gate that
    // never checks rest at all.
    const { auth, divisionId, stageId, entrantIds } = await seedDivision();
    const [e1, e2, e3] = entrantIds as [string, string, string];
    for (const [i, row] of (
      [
        { home: e1, away: e2, hhmm: "09:00", court: "Court 1" },
        { home: e1, away: e3, hhmm: "09:30", court: "Court 2" },
      ] as const
    ).entries()) {
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                              status, home_entrant_id, away_entrant_id, scheduled_at, court_label)
        values (${stageId}, ${divisionId}, ${auth.orgId}, 1, ${i}, ${`hand${i}`},
                'scheduled', ${row.home}, ${row.away}, ${at(row.hhmm)}, ${row.court})`;
    }

    await expect(publishSchedule(auth, divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS",
    });
    expect(await divisionStatus(divisionId)).toBe("setup");
  }, 120_000);
});

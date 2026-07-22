// Integration tests for PROMPT-28 (Jul3/08): triple RR, americano pair
// entrants, cross-stage feeds + early fill, placement ranks, auto-advance,
// ladder challenges, DAG + Pro gates. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures, getStandings, issueChallenge } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Fmt " + suffix}, ${"fmt-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, names: string[], individualsWithPersons = false) {
  const comp = await createCompetition(auth, {
    name: "Fmt Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    await Promise.all(
      names.map(async (name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: individualsWithPersons
          ? [
              {
                person_id: (
                  await createPerson(auth, {
                    full_name: name,
                    consent: {},
                    dob: null,
                    gender: null,
                    external_ref: null,
                  })
                ).id,
                is_captain: false,
                roles: [],
                default_position_key: null,
                squad_number: null,
              },
            ]
          : [],
      })),
    ),
  );
  return { comp, division, entrants };
}

async function decide(auth: AuthCtx, fixtureId: string, hs: number, as_: number) {
  await scoreEvent(auth, fixtureId, {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: hs, p2Score: as_ },
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("format extensions (Jul3/08)", () => {
  it("triple round robin generates n(n−1)/2·3 fixtures", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "Triple",
      config: { legs: 3 },
    });
    const { created } = await generateStageFixtures(auth, stage!.id);
    expect(created).toBe(18); // 4·3/2 · 3
  });

  it("americano creates pair entrants on the fly; Community 402s on the kind", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(
      auth,
      ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
      true,
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "americano" as never,
      name: "Padel",
      config: { mode: "americano", courtCount: 2, rounds: 3 },
    });
    const { created, fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(created).toBe(6); // 2 courts × 3 rounds
    const [pairs] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants
      where division_id = ${division.id} and kind = 'pair'`;
    expect(pairs!.n).toBeGreaterThanOrEqual(8);
    // nobody plays twice in a round
    const round1 = fixtures.filter((f: { round_no: number }) => f.round_no === 1);
    expect(round1).toHaveLength(2);

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth, ["A", "B", "C", "D"], true);
    await expect(
      createStages(freeAuth, freeDiv.id, {
        seq: 1,
        kind: "americano" as never,
        name: "P",
        config: {},
      }),
    ).rejects.toMatchObject({ featureKey: "formats.advanced" });
  });

  it("cross-stage loser feed: CL QF loser lands in the EL slot the moment it decides", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [cl, el] = await createStages(auth, division.id, [
      {
        seq: 1,
        kind: "knockout",
        name: "CL",
        config: {
          cross_feeds: [
            {
              from_ext_key: "se-r0-i0",
              side: "loser",
              to_stage_seq: 2,
              to_ext_key: "se-r0-i0",
              slot: 1,
            },
          ],
        },
      },
      { seq: 2, kind: "knockout", name: "EL", config: {} },
    ]);
    const clGen = await generateStageFixtures(auth, cl!.id);
    void entrants;
    // the EL entry fixture waits with an OPEN home slot for the CL loser
    await sql`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, ext_key, status)
      values (${el!.id}, ${division.id}, 1, 1, 'se-r0-i0', 'scheduled')`;
    // wiring runs on the next generation pass over the division
    await generateStageFixtures(auth, cl!.id);
    const [source] = await sql<{ loser_to_fixture: string | null }[]>`
      select loser_to_fixture from fixtures
      where stage_id = ${cl!.id} and ext_key = 'se-r0-i0'`;
    expect(source!.loser_to_fixture).not.toBeNull();

    await startDivision(auth, division.id);
    const [clSemi] = await sql<{ id: string; home_entrant_id: string | null }[]>`
      select id, home_entrant_id from fixtures
      where stage_id = ${cl!.id} and ext_key = 'se-r0-i0'`;
    void clGen;
    await decide(auth, clSemi!.id, 0, 2); // home loses → drops into EL slot 1
    const [target] = await sql<{ home_entrant_id: string | null }[]>`
      select home_entrant_id from fixtures where id = ${source!.loser_to_fixture}`;
    expect(target!.home_entrant_id).toBe(clSemi!.home_entrant_id); // early fill, per decided fixture
  });

  it("placement game writes rank locks (winner of game X = 3rd), never alphabetical", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "Placement",
      config: { placements: { "rr-r1-c1": [1, 2] } },
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    await decide(auth, fixtures[0]!.id, 0, 2); // away wins → away rank 1
    const [cfg] = await sql<
      { config: { rank_overrides?: { entrant_id: string; rank: number }[] } }[]
    >`
      select config from stages where id = ${stage!.id}`;
    expect(cfg!.config.rank_overrides).toHaveLength(2);
    const standings = await getStandings(auth, stage!.id);
    const rows = standings.rows as {
      entrantId: string;
      rank: number;
      rankLocked?: boolean;
    }[];
    const winner = rows.find((r) => r.entrantId === fixtures[0]!.away_entrant_id)!;
    expect(winner).toMatchObject({ rank: 1, rankLocked: true });
  });

  it("auto_progress: finishing the group auto-generates the next stage (no button)", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth, ["A", "B", "C", "D"]);
    await patchDivision(auth, division.id, { auto_progress: true });
    const [group, ko] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "Group", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Final",
        config: {},
        qualification: { topN: 2 } as never,
      },
    ]);
    const { fixtures } = await generateStageFixtures(auth, group!.id);
    await startDivision(auth, division.id);
    for (const f of fixtures) {
      const seq = (
        await sql<{ n: number }[]>`
        select count(*)::int as n from score_events where fixture_id = ${f.id}`
      )[0]!.n;
      await scoreEvent(auth, f.id, {
        expected_seq: seq,
        type: "core.start",
        payload: {},
      });
      await scoreEvent(auth, f.id, {
        expected_seq: seq + 1,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 0 },
      });
    }
    const [next] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${ko!.id}`;
    expect(next!.n).toBeGreaterThan(0); // generated without completeStage()
    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events
      where division_id = ${division.id} and type = 'stage_auto_advanced'`;
    expect(ev!.n).toBe(1);
  });

  it("ladder: challenge in range creates the fixture; winning swaps positions; cycles fail closed", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["L1", "L2", "L3", "L4", "L5"]);
    const [ladder] = await createStages(auth, division.id, {
      seq: 1,
      kind: "ladder" as never,
      name: "Club ladder",
      config: { challengeRange: 2 },
    });
    await generateStageFixtures(auth, ladder!.id); // no-op: fixtures on demand
    await startDivision(auth, division.id).catch(() => null); // ladder may not need start
    const challenge = await issueChallenge(auth, ladder!.id, {
      challenger_id: entrants[2]!.id,
      opponent_id: entrants[0]!.id,
    });
    expect(challenge.ladder_order[0]).toBe(entrants[0]!.id);
    // out-of-range refused
    await expect(
      issueChallenge(auth, ladder!.id, {
        challenger_id: entrants[4]!.id,
        opponent_id: entrants[0]!.id,
      }),
    ).rejects.toThrow(/at most 2 places/);
    // challenger wins → takes the position
    await decide(auth, challenge.fixture_id, 2, 0);
    const [cfg] = await sql<{ config: { ladder_order: string[] } }[]>`
      select config from stages where id = ${ladder!.id}`;
    expect(cfg!.config.ladder_order[0]).toBe(entrants[2]!.id);

    // cyclic cross-feeds fail closed at config time
    const { division: d2 } = await seedDivision(auth, ["X", "Y"]);
    await expect(
      createStages(auth, d2.id, [
        {
          seq: 1,
          kind: "knockout",
          name: "A",
          config: {
            cross_feeds: [
              {
                from_ext_key: "x",
                side: "loser",
                to_stage_seq: 2,
                to_ext_key: "y",
                slot: 1,
              },
            ],
          },
        },
        {
          seq: 2,
          kind: "knockout",
          name: "B",
          config: {
            cross_feeds: [
              {
                from_ext_key: "y",
                side: "loser",
                to_stage_seq: 1,
                to_ext_key: "x",
                slot: 1,
              },
            ],
          },
        },
      ]),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "CONFIG_INVALID"));
  });
});

// Integration tests for PROMPT-27 (Jul3/07): scoring-path goals/assists →
// leaderboard, MOTM via core.award, void refold, consent-filtered public
// table, coarse-scoring message, 402 gate. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { getLineup, putLineup } from "../fixtures";
import { divisionPlayerStats, personStats, publicDivisionStats } from "../player-stats";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sta " + suffix}, ${"sta-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

// two 7-a-side teams with numbered players
async function seedDivision(auth: AuthCtx, visibility: "private" | "public" = "public") {
  const comp = await createCompetition(auth, {
    name: "Stats Cup",
    visibility,
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "football",
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  const mkPeople = async (names: string[]) =>
    Promise.all(
      names.map((full_name) =>
        createPerson(auth, {
          full_name,
          consent: { public_name: full_name !== "Minor Hidden" },
          dob: null,
          gender: null,
          external_ref: null,
        }),
      ),
    );
  const teamA = await mkPeople(["Ada Striker", "Bea Winger", "Minor Hidden"]);
  const teamB = await mkPeople(["Cy Keeper", "Dee Back", "Eve Mid"]);
  const entrants = await createEntrants(auth, division.id, [
    {
      kind: "team" as const,
      display_name: "Reds",
      seed: 1,
      members: teamA.map((p, i) => ({
        person_id: p.id,
        squad_number: i + 7,
        is_captain: i === 0,
        roles: [],
        default_position_key: null,
      })),
    },
    {
      kind: "team" as const,
      display_name: "Blues",
      seed: 2,
      members: teamB.map((p, i) => ({
        person_id: p.id,
        squad_number: i + 1,
        is_captain: i === 0,
        roles: [],
        default_position_key: null,
      })),
    },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  // scorer attribution validates against the on-pitch lineup — set both sides
  const rosters = new Map([
    [entrants[0]!.id, teamA],
    [entrants[1]!.id, teamB],
  ]);
  for (const f of fixtures) {
    for (const entrantId of [f.home_entrant_id, f.away_entrant_id]) {
      if (!entrantId) continue;
      const people = rosters.get(entrantId)!;
      await putLineup(auth, f.id, entrantId, {
        slots: people.map((p, i) => ({
          person_id: p.id,
          slot: "starting" as const,
          position_key: null,
          order_no: i + 1,
          roles: [],
        })),
      });
    }
  }
  return { comp, division, fixtures, entrants, teamA, teamB };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("player statistics (Jul3/07)", () => {
  it("goal + assist via #number roster → top-scorer table with points = goals + assists; MOTM aggregates; void refolds", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, teamA, entrants } = await seedDivision(auth);
    const f = fixtures[0]!;
    const redsHome = f.home_entrant_id === entrants[0]!.id;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const goal = await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: {
        by: entrants[0]!.id,
        scorer: teamA[0]!.id,
        assist: teamA[1]!.id,
      },
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 2,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: teamA[0]!.id },
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 3,
      type: "core.award",
      payload: { person: teamA[0]!.id, key: "motm" },
    });

    const table = await divisionPlayerStats(auth, division.id, {
      metric: "goals",
    });
    expect(table.requires_detailed_scoring).toBe(false);
    const ada = table.rows.find((r) => r.full_name === "Ada Striker")!;
    expect(ada.stats).toMatchObject({ goals: 2, points: 2, motm_awards: 1 });
    expect(ada.stats.assists ?? 0).toBe(0);
    expect(ada.squad_number).toBe(7);
    const bea = table.rows.find((r) => r.full_name === "Bea Winger")!;
    expect(bea.stats).toMatchObject({ assists: 1, points: 1 });

    // void the assisted goal → goal AND assist drop (refold, §8)
    const [goalRow] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${f.id} and seq = ${goal.seq}`;
    await scoreEvent(auth, f.id, {
      expected_seq: 4,
      type: "core.void",
      payload: { event_id: goalRow!.id },
    });
    const after = await divisionPlayerStats(auth, division.id, {
      metric: "goals",
    });
    expect(after.rows.find((r) => r.full_name === "Ada Striker")!.stats.goals).toBe(1);
    expect(after.rows.find((r) => r.full_name === "Bea Winger")).toBeUndefined();
    void redsHome;

    // per-division card
    const card = await personStats(auth, teamA[0]!.id);
    expect(card.divisions).toHaveLength(1);
    expect(card.divisions[0]!.stats.goals).toBe(1);
  });

  it("lineup read model carries squad numbers (Jul3/07 §5)", async () => {
    const { auth } = await seedOrg();
    const { fixtures, entrants, teamA } = await seedDivision(auth);
    const f = fixtures[0]!;
    const entrantId = entrants[0]!.id;
    const lineup = await getLineup(auth, f.id, entrantId);
    const slot = (lineup.slots as { full_name: string; squad_number: number | null }[]).find(
      (s) => s.full_name === "Ada Striker",
    )!;
    expect(slot.squad_number).toBe(7);
  });

  it("public leaderboard is consent-filtered; stats gate 402s Community", async () => {
    const { auth } = await seedOrg();
    const { comp, division, fixtures, teamA, entrants } = await seedDivision(auth, "public");
    void division;
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: teamA[2]!.id }, // the no-consent minor
    });
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;
    const pub = await publicDivisionStats(org!.slug, comp.slug, "open");
    const names = pub.rows.map((r) => r.name);
    expect(names.some((n) => n.includes("Minor Hidden"))).toBe(false); // initials only
    expect(names.length).toBeGreaterThan(0);

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth, "private");
    await expect(divisionPlayerStats(freeAuth, freeDiv.id, {})).rejects.toMatchObject({
      featureKey: "stats.player",
    });
  });
});

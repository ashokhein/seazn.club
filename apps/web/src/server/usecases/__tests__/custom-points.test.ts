// Integration tests for PROMPT-25 (Jul3/05): points rule through the live
// scoring path, carry-over seeding, manual rank override, tie alert, Pro
// gates. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  createStages,
  generateStageFixtures,
  completeStage,
  getStandings,
  overrideStandings,
} from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pts " + suffix}, ${"pts-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
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
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedDivision(auth: AuthCtx, names: string[]) {
  const comp = await createCompetition(auth, { name: "Pts Cup", visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    names.map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  return { comp, division, entrants };
}

async function decide(auth: AuthCtx, fixtureId: string, hs: number, as_: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1, type: "generic.result", payload: { p1Score: hs, p2Score: as_ },
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("custom points & rank control (Jul3/05)", () => {
  it("netball 5/3 + losing-≥50% bonus flows through scoring → standings", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "league", name: "L",
      config: {
        points: {
          base: { win: 5, draw: 3, loss: 0 },
          bonuses: [{ when: "score_ratio_gte", param: 0.5, points: 1 }],
        },
      },
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    await decide(auth, fixtures[0]!.id, 12, 7); // loser ≥50% → bonus 1
    const standings = await getStandings(auth, stage!.id);
    const rows = standings.rows as { entrantId: string; points: number }[];
    const byId = new Map(entrants.map((e) => [e.id, e.display_name]));
    const points = Object.fromEntries(rows.map((r) => [byId.get(r.entrantId), r.points]));
    expect(points).toEqual({ A: 5, B: 1 });
  });

  it("forfeit awards configured points via core.forfeit; no invented score", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "league", name: "L",
      config: {
        points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: -1 } },
      },
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, f.id, {
      expected_seq: 1, type: "core.forfeit",
      payload: { by: f.away_entrant_id, reason: "no-show" },
    });
    const standings = await getStandings(auth, stage!.id);
    const rows = standings.rows as { entrantId: string; points: number; metrics: Record<string, number> }[];
    const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
    const a = rows.find((r) => r.entrantId === byName.get("A"))!;
    const b = rows.find((r) => r.entrantId === byName.get("B"))!;
    expect(a.points).toBe(3);
    expect(b.points).toBe(-1);
    expect(a.metrics.for ?? 0).toBe(0); // no fake score
  });

  it("two teams tied through the whole cascade carry the tie_unbroken alert", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    await decide(auth, fixtures[0]!.id, 2, 2); // draw — equal on everything
    const standings = await getStandings(auth, stage!.id);
    const rows = standings.rows as { tieUnbroken?: boolean }[];
    expect(rows.every((r) => r.tieUnbroken === true)).toBe(true);
  });

  it("manual override pins 3rd/4th and survives recompute; Community 402s", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    // A beats everyone; B beats C,D; C beats D → order A,B,C,D
    const byId = new Map(entrants.map((e) => [e.display_name, e.id]));
    for (const f of fixtures) {
      const homeName = [...byId.entries()].find(([, id]) => id === f.home_entrant_id)![0];
      const awayName = [...byId.entries()].find(([, id]) => id === f.away_entrant_id)![0];
      const homeWins = homeName < awayName; // alphabetical order wins
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    // placement game says D is 3rd
    await overrideStandings(auth, stage!.id, {
      rows: [
        { entrant_id: byId.get("D")!, rank: 3, reason: "placement game" },
        { entrant_id: byId.get("C")!, rank: 4, reason: "placement game" },
      ],
    });
    const standings = await getStandings(auth, stage!.id);
    const rows = standings.rows as { entrantId: string; rank: number; rankLocked?: boolean }[];
    const rank = (name: string) => rows.find((r) => r.entrantId === byId.get(name))!.rank;
    expect([rank("A"), rank("B"), rank("D"), rank("C")]).toEqual([1, 2, 3, 4]);
    expect(rows.find((r) => r.entrantId === byId.get("D"))!.rankLocked).toBe(true);
    // audit row present + chain intact
    const [ev] = await sql<{ broken: string | null }[]>`
      select verify_division_events_chain(${division.id})::text as broken`;
    expect(ev).toEqual({ broken: null });

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv, entrants: freeEntrants } = await seedDivision(freeAuth, ["A", "B"]);
    const [freeStage] = await createStages(freeAuth, freeDiv.id, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(freeAuth, freeStage!.id);
    await expect(
      overrideStandings(freeAuth, freeStage!.id, {
        rows: [{ entrant_id: freeEntrants[0]!.id, rank: 1, reason: "x" }],
      }),
    ).rejects.toMatchObject({ featureKey: "tiebreakers.custom" });
  });

  it("carry-over seeds Phase 2 with prior points; bonuses are Pro at stage create", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [g, final] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "Phase 1", config: {} },
      {
        seq: 2, kind: "league", name: "Super pool", config: {},
        qualification: { topN: 3, carry: "points" } as never,
      },
    ]);
    const { fixtures } = await generateStageFixtures(auth, g!.id);
    await startDivision(auth, division.id);
    const byId = new Map(entrants.map((e) => [e.display_name, e.id]));
    for (const f of fixtures) {
      const homeName = [...byId.entries()].find(([, id]) => id === f.home_entrant_id)![0];
      const awayName = [...byId.entries()].find(([, id]) => id === f.away_entrant_id)![0];
      const homeWins = homeName < awayName;
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    await completeStage(auth, g!.id);
    const [next] = await sql<{ config: { carry_deltas?: { entrantId: string; points: number }[] } }[]>`
      select config from stages where id = ${final!.id}`;
    expect(next!.config.carry_deltas).toBeDefined();
    const carried = next!.config.carry_deltas!;
    expect(carried.find((d) => d.entrantId === byId.get("A"))!.points).toBe(9);
    // standings_carried in the ledger
    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events
      where division_id = ${division.id} and type = 'standings_carried'`;
    expect(ev!.n).toBe(1);

    // Pro gates at stage create
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth, ["A", "B"]);
    await expect(
      createStages(freeAuth, freeDiv.id, {
        seq: 1, kind: "league", name: "L",
        config: { points: { base: { win: 5, draw: 3, loss: 0 }, bonuses: [{ when: "draw", points: 1 }] } },
      }),
    ).rejects.toMatchObject({ featureKey: "standings.custom_points" });
    await expect(
      createStages(freeAuth, freeDiv.id, [
        { seq: 1, kind: "league", name: "L", config: {} },
        { seq: 2, kind: "league", name: "S", config: {}, qualification: { topN: 1, carry: "points" } as never },
      ]),
    ).rejects.toMatchObject({ featureKey: "standings.carry_over" });
  });
});

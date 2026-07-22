// PROMPT-59 round-trip (the test the wave skipped — and the stg capstone then
// hit): a knockout stage whose qualification is a COMBINED spec must survive
// the usecase layer's own spec check (stages.ts resolveNextStage) and generate
// its bracket honouring slotOrder. Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, createStages, generateStageFixtures } from "../stages";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Cq " + suffix}, ${"cq-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
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

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("combined qualification round-trip (PROMPT-59)", () => {
  it("group → complete → combined-spec knockout generates with slotOrder honoured", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      name: "Cq Cup " + randomUUID().slice(0, 6),
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
    // 12 entrants → 4 pools of 3 (seeded-snake).
    const entrants = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 12 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    void entrants;
    const slotOrder = [1, 6, 4, 7, 2, 5, 3, 8]; // custom map over the 8 combined seeds
    const stages = await createStages(auth, division.id, [
      {
        seq: 1,
        kind: "group",
        name: "Groups",
        config: { pools: { count: 4 } },
        qualification: null,
      },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: { slotOrder },
        qualification: {
          combine: [
            { take: ["A", "B", "C", "D"].map((pool) => ({ pool, rank: 1 })) },
            { bestOfRank: { rank: 2, count: 4 } },
          ],
        } as never,
      },
    ]);
    const group = stages.find((s) => s.kind === "group")!;
    const ko = stages.find((s) => s.kind === "knockout")!;
    const gen = await generateStageFixtures(auth, group.id);
    expect(gen.created).toBeGreaterThan(0);

    // Decide every group fixture: higher entrant id string wins deterministically
    // by seed — home wins when home seed lower (E1 beats E2, etc.).
    const fixtures = await sql<
      { id: string; home_entrant_id: string; away_entrant_id: string }[]
    >`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${group.id}`;
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    for (const f of fixtures) {
      const homeWins =
        (seedOf.get(f.home_entrant_id) ?? 99) < (seedOf.get(f.away_entrant_id) ?? 99);
      await appendEvent(auth.orgId, f.id, 0, {
        type: "core.start",
        payload: {},
      });
      await appendEvent(auth.orgId, f.id, 1, {
        type: "generic.result",
        payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
      });
    }

    // The failing step on stg: completion resolves the COMBINED spec.
    const done = await completeStage(auth, group.id);
    expect(done.completed).toBe(true);
    expect(done.qualified?.entrants).toHaveLength(8);

    // Completion already auto-generates the next stage; the explicit call is
    // the idempotent no-op path. Either way: 7 bracket fixtures exist.
    const kgen = await generateStageFixtures(auth, ko.id);
    expect(kgen.created + kgen.existing).toBe(7); // 8-team single elim (incl. later rounds)

    // slotOrder honoured: round-one pairings follow the map over the combined
    // seed list (4 winners then 4 best-seconds, each ordered deterministically).
    const seeds = done.qualified!.entrants;
    const r1 = await sql<
      {
        seq_in_round: number;
        home_entrant_id: string;
        away_entrant_id: string;
      }[]
    >`select seq_in_round, home_entrant_id, away_entrant_id from fixtures
      where stage_id = ${ko.id}
        and round_no = (select min(round_no) from fixtures where stage_id = ${ko.id})
      order by seq_in_round`;
    expect(r1).toHaveLength(4);
    r1.forEach((f, i) => {
      expect(f.home_entrant_id).toBe(seeds[slotOrder[2 * i]! - 1]);
      expect(f.away_entrant_id).toBe(seeds[slotOrder[2 * i + 1]! - 1]);
    });
  });
});

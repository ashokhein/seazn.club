// PROMPT-13 acceptance: (1) matrix test — feature_key × plan asserted at the
// ENFORCEMENT POINT (the use-case call), not just hasFeature; (2) downgrade
// simulation — pro → community keeps data, over-quota freezes, coarse scoring
// still works. Real Postgres required (RLS, triggers); skipped without
// DATABASE_URL — CI runs them against its service container. Redis is
// intentionally absent here: every entitlement read exercises the documented
// fail-open path (cache miss → Postgres).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition, listCompetitions, getCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createApiKey } from "../api-keys";

const HAS_DB = !!process.env.DATABASE_URL;

type Plan = "community" | "pro" | "business";

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: Plan): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ent " + suffix}, ${"ent-" + suffix})
    returning id`;
  // No subscription row = community (the resolver's fallback).
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog) values
      ('generic',  'Generic',  '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })}),
      ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)}),
      ('cricket',  'Cricket',  ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system) values
      ('generic',  'score',   'Score',   ${sql.json(GENERIC_CONFIG)}, true),
      ('football', 'default', 'Default', ${sql.json({})}, true),
      ('cricket',  't20',     'T20',     ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function setPlan(orgId: string, plan: Plan): Promise<void> {
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, ${plan}, 'active')
    on conflict (org_id) do update set plan_key = ${plan}`;
  await invalidateOrgEntitlements(orgId);
}

async function makeCompetition(
  auth: AuthCtx,
  name: string,
  visibility: "private" | "public" = "private",
) {
  return createCompetition(auth, { name, visibility, branding: {} });
}

async function makeDivision(auth: AuthCtx, competitionId: string, sport: string, config: object) {
  return createDivision(auth, competitionId, {
    name: `Div ${randomUUID().slice(0, 6)}`,
    sport_key: sport,
    variant_key: sport === "generic" ? "score" : sport === "football" ? "default" : "t20",
    config,
    eligibility: [],
  } as never);
}

/** division + 2 entrants + generated league fixture — the scoring probe rig. */
async function makeFixture(auth: AuthCtx, competitionId: string, sport: string, config: object) {
  const division = await makeDivision(auth, competitionId, sport, config);
  const entrants = await createEntrants(auth, division.id, [
    { kind: "individual", display_name: "A", seed: 1, members: [] },
    { kind: "individual", display_name: "B", seed: 2, members: [] },
  ] as never);
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  } as never);
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  // Scoring opens only after start (doc 12 §1, PROMPT-17).
  await startDivision(auth, division.id);
  return { division, entrants, fixtureId: fixtures[0].id };
}

// ---------------------------------------------------------------------------
// The matrix: feature_key × plan, probed at the enforcement point. `probe`
// performs the just-over-the-limit action; deny must be a 402 carrying
// exactly this feature_key (the UpgradeGate contract, doc 10 §3).
// ---------------------------------------------------------------------------
const MATRIX: { feature: string; plan: Plan; allowed: boolean }[] = [
  { feature: "competitions.max_active",       plan: "community", allowed: false },
  { feature: "competitions.max_active",       plan: "pro",       allowed: true },
  { feature: "dashboard.public.max",          plan: "community", allowed: false },
  { feature: "dashboard.public.max",          plan: "pro",       allowed: true },
  { feature: "divisions.per_competition.max", plan: "community", allowed: false },
  { feature: "divisions.per_competition.max", plan: "pro",       allowed: true },
  { feature: "stages.per_division.max",       plan: "community", allowed: false },
  { feature: "stages.per_division.max",       plan: "pro",       allowed: true },
  { feature: "entrants.per_division.max",     plan: "community", allowed: false },
  { feature: "entrants.per_division.max",     plan: "pro",       allowed: true },
  { feature: "formats.double_elim",           plan: "community", allowed: false },
  { feature: "formats.double_elim",           plan: "pro",       allowed: true },
  { feature: "scoring.match_timeline",        plan: "community", allowed: false },
  { feature: "scoring.match_timeline",        plan: "pro",       allowed: true },
  { feature: "cricket.dls",                   plan: "community", allowed: false },
  { feature: "cricket.dls",                   plan: "pro",       allowed: true },
  { feature: "api.access",                    plan: "community", allowed: false },
  { feature: "api.access",                    plan: "pro",       allowed: true },
  // v3/08 §2 (V265): the Business api.write rung died with the v3 Business
  // scrub — write/manage keys are plain Pro under api.access (a community
  // org's write-key attempt now 402s on api.access, covered above).
  { feature: "api.write",                     plan: "pro",       allowed: true },
];

async function probe(feature: string, auth: AuthCtx): Promise<() => Promise<unknown>> {
  switch (feature) {
    case "competitions.max_active": {
      await makeCompetition(auth, "C1");
      await makeCompetition(auth, "C2");
      return () => makeCompetition(auth, "C3"); // 3rd active
    }
    case "dashboard.public.max": {
      await makeCompetition(auth, "P1", "public");
      return () => makeCompetition(auth, "P2", "public"); // 2nd public
    }
    case "divisions.per_competition.max": {
      const comp = await makeCompetition(auth, "D");
      await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      return () => makeDivision(auth, comp.id, "generic", GENERIC_CONFIG); // 2nd division
    }
    case "stages.per_division.max": {
      const comp = await makeCompetition(auth, "S");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      await createStages(auth, division.id, [
        { seq: 1, kind: "league", name: "S1", config: {} },
        { seq: 2, kind: "knockout", name: "S2", config: {} },
      ] as never);
      return () => // 3rd stage
        createStages(auth, division.id, { seq: 3, kind: "knockout", name: "S3", config: {} } as never);
    }
    case "entrants.per_division.max": {
      const comp = await makeCompetition(auth, "E");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      await createEntrants(
        auth,
        division.id,
        Array.from({ length: 16 }, (_, i) => ({
          kind: "individual" as const, display_name: `E${i}`, seed: i + 1, members: [],
        })) as never,
      );
      return () => // 17th entrant
        createEntrants(auth, division.id, [
          { kind: "individual", display_name: "E17", seed: 17, members: [] },
        ] as never);
    }
    case "formats.double_elim": {
      const comp = await makeCompetition(auth, "DE");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      return () =>
        createStages(auth, division.id, { seq: 1, kind: "double_elim", name: "DE", config: {} } as never);
    }
    case "scoring.match_timeline": {
      const comp = await makeCompetition(auth, "F");
      const { entrants, fixtureId } = await makeFixture(auth, comp.id, "football", {});
      return () => // Tier-2 attributed event (a card, valid pre-kickoff)
        scoreEvent(auth, fixtureId, {
          expected_seq: 0,
          type: "football.card",
          payload: { by: entrants[0].id, color: "yellow" },
        });
    }
    case "cricket.dls": {
      const comp = await makeCompetition(auth, "CR");
      const { fixtureId } = await makeFixture(auth, comp.id, "cricket", {
        dls: { enabled: true, edition: "standard" },
      });
      return () => // revise WITHOUT a manual target ⇒ fold computes DLS
        scoreEvent(auth, fixtureId, {
          expected_seq: 0,
          type: "cricket.revise",
          payload: { oversPerSide: 10 },
        });
    }
    case "api.access":
      return () => createApiKey(auth, { name: "k", scopes: ["read"] });
    case "api.write":
      return () => createApiKey(auth, { name: "k", scopes: ["read", "write"] });
    default:
      throw new Error(`no probe for ${feature}`);
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entitlements v2 matrix (doc 10 §1/§2)", () => {
  it.each(MATRIX)("$feature × $plan → allowed=$allowed", async ({ feature, plan, allowed }) => {
    const { auth } = await seedOrg(plan);
    const act = await probe(feature, auth);
    if (allowed) {
      await expect(act()).resolves.toBeDefined();
    } else {
      await expect(act()).rejects.toMatchObject({ status: 402, featureKey: feature });
    }
  });

  it("cricket.revise with a MANUAL umpire target is always allowed (doc 10 §1)", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "CRM");
    const { fixtureId } = await makeFixture(auth, comp.id, "cricket", {
      dls: { enabled: true, edition: "standard" },
    });
    const out = await scoreEvent(auth, fixtureId, {
      expected_seq: 0,
      type: "cricket.revise",
      payload: { oversPerSide: 10, target: 95 },
    });
    expect(out.seq).toBe(1);
  });

  it("coarse scoring never needs a plan: community appends a football goal", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "FG");
    const { entrants, fixtureId } = await makeFixture(auth, comp.id, "football", {});
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const out = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: entrants[0].id },
    });
    expect(out.seq).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("downgrade simulation (doc 10 §2.4)", () => {
  it("pro → community: data kept, over-quota frozen, coarse scoring still works", async () => {
    const { auth } = await seedOrg("pro");

    // Three active competitions under Pro. B carries real play (a generic
    // fixture we keep scoring, plus a football division with fine events).
    const compA = await makeCompetition(auth, "Alpha");
    const compB = await makeCompetition(auth, "Beta");
    const compC = await makeCompetition(auth, "Gamma");
    const rigGeneric = await makeFixture(auth, compB.id, "generic", GENERIC_CONFIG);
    const rigFootball = await makeFixture(auth, compB.id, "football", {});

    // Fine event under Pro: allowed (and stays visible after the downgrade).
    await scoreEvent(auth, rigFootball.fixtureId, {
      expected_seq: 0,
      type: "football.card",
      payload: { by: rigFootball.entrants[0].id, color: "yellow" },
    });
    await scoreEvent(auth, rigGeneric.fixtureId, {
      expected_seq: 0, type: "core.start", payload: {},
    });

    // Deterministic activity order: A oldest, C newer, B newest (score events).
    await sql`update competitions set created_at = now() - interval '2 hours' where id = ${compA.id}`;
    await sql`update competitions set created_at = now() - interval '1 hour' where id = ${compC.id}`;

    await setPlan(auth.orgId, "community");

    // Nothing deleted; the least recently active competition freezes.
    const { items } = await listCompetitions(auth, { cursor: null, limit: 50 });
    expect(items).toHaveLength(3);
    const byId = new Map(items.map((c) => [c.id, c]));
    expect(byId.get(compA.id)?.frozen).toBe(true);
    expect(byId.get(compB.id)?.frozen).toBe(false);
    expect(byId.get(compC.id)?.frozen).toBe(false);
    expect((await getCompetition(auth, compA.id)).frozen).toBe(true);

    // Frozen = read-only: no new structure, no renames…
    await expect(makeDivision(auth, compA.id, "generic", GENERIC_CONFIG)).rejects.toMatchObject({
      status: 402, featureKey: "competitions.max_active",
    });
    await expect(patchCompetition(auth, compA.id, { name: "Alpha 2" })).rejects.toMatchObject({
      status: 402, featureKey: "competitions.max_active",
    });

    // …but coarse scoring in the surviving competitions still works,
    await scoreEvent(auth, rigGeneric.fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    // …while NEW fine events are rejected (history stays in the ledger).
    await expect(
      scoreEvent(auth, rigFootball.fixtureId, {
        expected_seq: 1,
        type: "football.card",
        payload: { by: rigFootball.entrants[1].id, color: "yellow" },
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "scoring.match_timeline" });

    // Retiring a frozen competition is the sanctioned way back under quota.
    await patchCompetition(auth, compA.id, { status: "archived" });
    const after = await listCompetitions(auth, { cursor: null, limit: 50 });
    expect(after.items.every((c) => !c.frozen)).toBe(true);
  });
});

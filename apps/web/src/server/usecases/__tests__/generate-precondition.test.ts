// Regression (design/fix-ui/03-console-division.md "Group-stage 'Générer les
// matchs' gives a misleading success message when it generates nothing"): a
// Groups+Knockout division with too few entrants (2, snake-distributed across
// e.g. 4 configured groups) used to return `{ created: 0, existing: 0 }` from
// generateStageFixtures — the exact same shape the client treats as "already
// generated, run again, nothing changed" (msg schedule.notice.nothingNew,
// green success banner) — even though ZERO fixtures had ever been created and
// the phase card still read "no matches yet". The precondition failure (not
// enough entrants to fill the groups) must throw a distinguishable error
// instead of silently no-op'ing as a success.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Gp " + suffix}, ${"gp-" + suffix})
    returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'pro', 'active')
    on conflict (org_id) do update set plan_key = 'pro'`;
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
  const comp = await createCompetition(auth, {
    name: "Gp Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open Singles", slug: "open-singles", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  return { division, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("generateStageFixtures — group-stage precondition (not a silent no-op)", () => {
  it("throws STAGE_NOT_READY with reason group_too_few_entrants instead of created:0/existing:0", async () => {
    const { auth } = await seedOrg();
    // 2 entrants, 4 configured groups: passes the >=2 total-entrants gate but
    // snake-distributes to 0/1 entrant per group — nothing to pair.
    const { division } = await seedDivision(auth, ["Alice", "Bob"]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "group", name: "Group stage", config: { pools: { count: 4 } }, qualification: null,
    });

    await expect(generateStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      code: "STAGE_NOT_READY",
    });

    try {
      await generateStageFixtures(auth, stage!.id);
      expect.unreachable("expected generateStageFixtures to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      const e = err as EngineError;
      expect(e.code).toBe("STAGE_NOT_READY");
      expect((e.data as { reason?: string }).reason).toBe("group_too_few_entrants");
    }

    // No fixtures were created by the failed attempt — this is a
    // precondition failure, not a partial/degenerate success.
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;
    expect(Number(count)).toBe(0);
  });

  it("still generates normally once enough entrants fill the groups", async () => {
    const { auth } = await seedOrg();
    const names = Array.from({ length: 8 }, (_, i) => `E${i + 1}`);
    const { division } = await seedDivision(auth, names);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "group", name: "Group stage", config: { pools: { count: 4 } }, qualification: null,
    });

    const { created } = await generateStageFixtures(auth, stage!.id);
    expect(created).toBeGreaterThan(0);
  });
});

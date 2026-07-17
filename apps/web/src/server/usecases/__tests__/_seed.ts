// Shared DB-backed seed helpers for officials-unify tests (Tasks 1/2/3/7).
// Copied verbatim from me-officiating.test.ts (do not modify that file).
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";

export const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

export async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true)
    returning id`;
  return { id, email };
}

export async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"V11 " + suffix}, ${"v11-" + suffix}, ${owner.id}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
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
  return { auth: { orgId, via: "session", userId: owner.id, role: "owner", keyId: null } };
}

/** Division with FUTURE fixtures — the /me lane and re-accept both filter on
 *  matchday, so dates must be ahead of now. */
export async function seedFutureDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "V11 Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "League", config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const t0 = Date.now() + 7 * 86_400_000;
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_label = 'Court 1'
      where id = ${fixtures[i]!.id}`;
  }
  return { division, fixtures };
}

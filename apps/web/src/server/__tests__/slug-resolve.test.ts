// Slug-chain resolution (PROMPT-30): live rows win, renamed slugs answer
// { renamedTo }, cross-parent lookups miss (existence never leaks), and
// fixtureByNo maps the human ordinal back to the row.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import {
  orgBySlug,
  compBySlug,
  divBySlug,
  fixtureByNo,
  breadcrumbNames,
} from "@/server/slug-resolve";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `res-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Res " + suffix}, ${orgSlug})
    returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'pro', 'active')
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
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgSlug,
  };
}

describe.skipIf(!HAS_DB)("slug-resolve (PROMPT-30)", () => {
  it("resolves a live org/comp/div chain and misses across parents", async () => {
    const { auth, orgSlug } = await seedOrg();
    const comp = await createCompetition(auth, {
      name: "Chain Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    const org = await orgBySlug(orgSlug);
    expect(org && "id" in org && org.id).toBe(auth.orgId);
    const c = await compBySlug(auth.orgId, comp.slug);
    expect(c && "id" in c && c.id).toBe(comp.id);
    const d = await divBySlug(comp.id, div.slug);
    expect(d && "id" in d && d.id).toBe(div.id);

    // Same comp slug under a different org → miss.
    const other = await seedOrg();
    expect(await compBySlug(other.auth.orgId, comp.slug)).toBeNull();
    expect(await orgBySlug(`missing-${randomUUID().slice(0, 8)}`)).toBeNull();
  });

  it("answers renamedTo for a renamed competition slug", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      name: "Before Cup",
      visibility: "private",
      branding: {},
    });
    await patchCompetition(auth, comp.id, { name: "After Cup" });
    const res = await compBySlug(auth.orgId, "before-cup");
    expect(res).toEqual({ renamedTo: "after-cup" });
  });

  it("maps fixture ordinals per division", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      name: "Ordinal Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, config)
      values (${div.id}, ${auth.orgId}, 1, 'league', 'S1', '{}') returning id`;
    const fid = randomUUID();
    await sql`
      insert into fixtures ${sql([
        {
          id: fid,
          stage_id: stageId,
          division_id: div.id,
          round_no: 1,
          seq_in_round: 1,
          ext_key: `sr-${randomUUID().slice(0, 6)}`,
          status: "scheduled",
        },
      ])}`;
    expect(await fixtureByNo(div.id, 1)).toEqual({ id: fid });
    expect(await fixtureByNo(div.id, 99)).toBeNull();
    expect(await fixtureByNo(div.id, 1.5)).toBeNull();
  });

  it("breadcrumbNames maps slugs to display names", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      name: "Crumb Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "U16 Boys",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    const names = await breadcrumbNames(auth.orgId);
    expect(names.comps[comp.slug]).toBe("Crumb Cup");
    expect(names.divs[`${comp.slug}/${div.slug}`]).toBe("U16 Boys");
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});

// Slug hygiene (PROMPT-30, v3/01 §2): generated slugs dedupe per parent with
// "-2" suffixes instead of 409ing, "new" is reserved (static /c/new, /d/new
// routes win over [slug]), renames regenerate the slug and keep the old one
// redirecting via slug_history, and org slugs become readable (name-derived).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { uniqueSlug } from "@/server/usecases/slugs";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision, patchDivision } from "@/server/usecases/divisions";

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
    insert into organizations (name, slug) values (${"Slug " + suffix}, ${"slug-" + suffix})
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

const compInput = (name: string) => ({
  name,
  visibility: "private" as const,
  branding: {},
});

const divInput = (name: string) => ({
  name,
  sport_key: "generic",
  variant_key: "score",
  config: GENERIC_CONFIG,
  eligibility: [],
});

describe("uniqueSlug", () => {
  it("suffixes -2, -3 until free and skips the reserved base", async () => {
    const taken = new Set(["cup", "cup-2"]);
    expect(await uniqueSlug("cup", async (s) => taken.has(s))).toBe("cup-3");
    expect(await uniqueSlug("open", async () => false)).toBe("open");
    expect(await uniqueSlug("new", async () => false)).toBe("new-2");
  });
});

describe.skipIf(!HAS_DB)("slug hygiene (PROMPT-30)", () => {
  it("generated competition slugs dedupe per org instead of 409ing", async () => {
    const { auth } = await seedOrg();
    const a = await createCompetition(auth, compInput("Summer Smash"));
    const b = await createCompetition(auth, compInput("Summer Smash"));
    expect(a.slug).toBe("summer-smash");
    expect(b.slug).toBe("summer-smash-2");
  });

  it("same competition name in two orgs gets a clean slug in each", async () => {
    const one = await seedOrg();
    const two = await seedOrg();
    const a = await createCompetition(one.auth, compInput("Winter Cup"));
    const b = await createCompetition(two.auth, compInput("Winter Cup"));
    expect(a.slug).toBe("winter-cup");
    expect(b.slug).toBe("winter-cup");
  });

  it("a competition named 'New' avoids the reserved slug", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("New"));
    expect(c.slug).toBe("new-2");
  });

  it("an explicit slug still 409s on collision and 422s when reserved", async () => {
    const { auth } = await seedOrg();
    await createCompetition(auth, { ...compInput("First"), slug: "taken" });
    await expect(
      createCompetition(auth, { ...compInput("Second"), slug: "taken" }),
    ).rejects.toThrow(HttpError);
    await expect(createCompetition(auth, { ...compInput("Third"), slug: "new" })).rejects.toThrow(
      /reserved/,
    );
  });

  it("competition rename regenerates the slug and records history", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Spring Open"));
    const renamed = await patchCompetition(auth, c.id, { name: "Autumn Open" });
    expect(renamed.slug).toBe("autumn-open");
    const [hist] = await sql<{ entity_id: string }[]>`
      select entity_id from slug_history
      where entity_type = 'competition' and parent_id = ${auth.orgId}
        and old_slug = 'spring-open'`;
    expect(hist?.entity_id).toBe(c.id);
  });

  it("division rename regenerates the slug and records history under the competition", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Host Cup"));
    const d = await createDivision(auth, c.id, divInput("U16 Boys"));
    expect(d.slug).toBe("u16-boys");
    const renamed = await patchDivision(auth, d.id, { name: "U18 Boys" });
    expect(renamed.slug).toBe("u18-boys");
    const [hist] = await sql<{ entity_id: string }[]>`
      select entity_id from slug_history
      where entity_type = 'division' and parent_id = ${c.id}
        and old_slug = 'u16-boys'`;
    expect(hist?.entity_id).toBe(d.id);
  });

  it("org creation derives a readable slug; duplicates and reserved names dedupe", async () => {
    const { createOrgForUser } = await import("@/lib/auth");
    const mk = async (name: string) => {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into users (email, display_name)
        values (${`slug-${randomUUID().slice(0, 8)}@test.local`}, 'Slug Tester')
        returning id`;
      return createOrgForUser(id, name);
    };
    const suffix = randomUUID().slice(0, 6);
    const a = await mk(`Riverside ${suffix}`);
    expect(a.slug).toBe(`riverside-${suffix}`);
    const b = await mk(`Riverside ${suffix}`);
    expect(b.slug).toBe(`riverside-${suffix}-2`);
    // App routes stay reserved for org slugs (/shared/[orgSlug] guard).
    const c = await mk("Settings");
    expect(c.slug).toMatch(/^settings-\d+$/);
  });

  it("generated division slugs dedupe within the competition", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Dup Cup"));
    const a = await createDivision(auth, c.id, divInput("Open"));
    const b = await createDivision(auth, c.id, divInput("Open"));
    expect(a.slug).toBe("open");
    expect(b.slug).toBe("open-2");
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});

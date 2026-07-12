// Slug-cache invalidation call-site coverage (Task 2 review finding 3):
// slug-hygiene.test.ts proves renames regenerate the slug and record
// slug_history, but nothing asserted that patchCompetition/patchDivision
// actually CALL invalidateSlugCache — a caller could record history and
// still leave the stale Redis entry live for up to the 60s TTL. `@/server/
// slug-resolve` is partially mocked so invalidateSlugCache still runs for
// real (it's inert without REDIS_URL) but as a spy we can assert on.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";

vi.mock("@/server/slug-resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/slug-resolve")>();
  return { ...actual, invalidateSlugCache: vi.fn(actual.invalidateSlugCache) };
});

import { invalidateSlugCache } from "@/server/slug-resolve";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision, patchDivision } from "@/server/usecases/divisions";

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAS_DB)("slug cache invalidation call sites (Task 2 review finding 3)", () => {
  it("competition rename calls invalidateSlugCache once with the old and new slug", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Spring Open"));
    const renamed = await patchCompetition(auth, c.id, { name: "Autumn Open" });
    expect(renamed.slug).toBe("autumn-open");
    expect(invalidateSlugCache).toHaveBeenCalledTimes(1);
    expect(invalidateSlugCache).toHaveBeenCalledWith(
      "competition",
      auth.orgId,
      "spring-open",
      "autumn-open",
    );
  });

  it("a competition patch that doesn't touch the name never invalidates the slug cache", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Steady Cup"));
    const patched = await patchCompetition(auth, c.id, { description: "Now with a blurb" });
    expect(patched.slug).toBe("steady-cup");
    expect(invalidateSlugCache).not.toHaveBeenCalled();
  });

  it("division rename calls invalidateSlugCache once with the competition as parent", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Host Cup"));
    const d = await createDivision(auth, c.id, divInput("U16 Boys"));
    const renamed = await patchDivision(auth, d.id, { name: "U18 Boys" });
    expect(renamed.slug).toBe("u18-boys");
    expect(invalidateSlugCache).toHaveBeenCalledTimes(1);
    expect(invalidateSlugCache).toHaveBeenCalledWith("division", c.id, "u16-boys", "u18-boys");
  });

  it("a division patch that doesn't touch the name never invalidates the slug cache", async () => {
    const { auth } = await seedOrg();
    const c = await createCompetition(auth, compInput("Quiet Cup"));
    const d = await createDivision(auth, c.id, divInput("Open"));
    const patched = await patchDivision(auth, d.id, { officials_hide_names: true });
    expect(patched.slug).toBe("open");
    expect(invalidateSlugCache).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});

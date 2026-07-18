// PROMPT-60 — entrants.badge_url: persisted on create, editable via PATCH,
// surfaced by the console logo map (precedence over the team logo) and by
// public_entrants_v (V289). Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { listEntrantLogoUrls } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bd " + suffix}, ${"bd-" + suffix})
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

async function seedDivision(auth: AuthCtx, visibility: "private" | "public" = "private") {
  const comp = await createCompetition(auth, {
    name: "Bd Cup " + randomUUID().slice(0, 6), visibility, branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  return { comp, division };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entrants.badge_url (PROMPT-60)", () => {
  it("persists on create, returns in the row, and PATCH updates/clears it", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth);
    const [row] = await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: "Mexico",
        seed: 1,
        members: [],
        badge_url: "https://flags.example/mex.png",
      } as never,
    ]);
    expect((row as { badge_url?: string | null }).badge_url).toBe("https://flags.example/mex.png");

    const patched = await patchEntrant(auth, row!.id, {
      badge_url: "entrant-badges/mex.png",
    } as never);
    expect((patched as { badge_url?: string | null }).badge_url).toBe("entrant-badges/mex.png");

    const cleared = await patchEntrant(auth, row!.id, { badge_url: null } as never);
    expect((cleared as { badge_url?: string | null }).badge_url).toBeNull();
  });

  it("listEntrantLogoUrls prefers the entrant badge over the team logo", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth);
    const [withBadge] = await createEntrants(auth, division.id, [
      {
        kind: "individual", display_name: "Badged", seed: 1, members: [],
        badge_url: "https://flags.example/a.png",
      } as never,
    ]);
    const [plain] = await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Plain", seed: 2, members: [] },
    ]);
    const map = await listEntrantLogoUrls(auth, division.id);
    expect(map[withBadge!.id]).toBe("https://flags.example/a.png");
    expect(map[plain!.id]).toBeNull();
  });

  it("public_entrants_v exposes badge_url for public competitions (V289)", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth, "public");
    const [row] = await createEntrants(auth, division.id, [
      {
        kind: "individual", display_name: "Flagged", seed: 1, members: [],
        badge_url: "entrant-badges/x.png",
      } as never,
    ]);
    const [pub] = await sql<{ badge_url: string | null }[]>`
      select badge_url from public_entrants_v where id = ${row!.id}`;
    expect(pub.badge_url).toBe("entrant-badges/x.png");
  });
});

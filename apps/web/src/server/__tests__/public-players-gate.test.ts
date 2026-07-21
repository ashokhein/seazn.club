// Task 4 — the `dashboard.player_profiles` gate moved OUT of public_players_v
// (V307) and INTO getPublicPlayer, the view's only consumer.
//
// The view could not take the competition as a parameter: its gate sat over
// `from persons p`, and a person plays in many competitions — the only
// competition reference is inside the correlated exists() BELOW the gate.
// Pushing the gate in there would have re-read it as "*some* competition this
// person appears in is entitled", so a single Event Pass would have exposed
// that person across every unpaid competition in the org. Hence the caller,
// which already knows which competition is being viewed.
//
// The view keeps consent + public-visibility (asserted in
// public-site/__tests__/consent.test.ts); the entitlement lives here.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// unstable_cache is a Next server-runtime API, absent under vitest. This double
// deliberately MEMOISES rather than passing through, because the placement of
// the gate is half the point of this task: entitlement changes do not bust a
// `competition:{id}` tag, so a gate evaluated INSIDE the cached closure would
// stay frozen for a whole REVALIDATE_SLOW window and keep serving player cards
// for an org that just lost the feature. A memoising double is what makes that
// failure observable from a test.
const { cacheStore } = vi.hoisted(() => ({ cacheStore: new Map<string, unknown>() }));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, keyParts: string[]) =>
    async () => {
      const k = JSON.stringify(keyParts);
      if (!cacheStore.has(k)) cacheStore.set(k, await fn());
      return cacheStore.get(k);
    },
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { getPublicPlayer } from "@/server/public-site/data";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Scene {
  orgId: string;
  orgSlug: string;
  personId: string;
  personName: string;
  /** Carries the pass — entitled. */
  passedSlug: string;
  passedId: string;
  /** Same org, no pass — must stay dark. */
  unpassedSlug: string;
}

/**
 * A COMMUNITY org with one consented person rostered in TWO unlisted
 * competitions, one of which carries a competition pass.
 *
 * The pass is keyed to the `pro` matrix rather than `event_pass`: the shipped
 * event_pass matrix is deliberately sparse and has no dashboard.player_profiles
 * row at all today (it falls through to the plan row), so it could not separate
 * the two competitions. competition_passes.pass_key is a plain FK to plans.key
 * and the resolver joins plan_entitlements on it, so this exercises the real
 * per-competition mechanism without editing the shipped matrix.
 *
 * Unlisted, not public: community orgs hold at most one PUBLIC competition
 * (dashboard.public.max), and unlisted is equally visible to public_players_v.
 */
async function seedScene(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug)
    values (${"Gate " + suffix}, ${"gate-" + suffix}) returning id, slug`;
  // A raw org insert creates no subscriptions row; seed community explicitly so
  // the plan under test is stated, not inferred from a missing row.
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active')`;
  // Two active competitions exceed the community cap (competitions.max_active);
  // the cap is not what is under test — lift it for this org only.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  await invalidateOrgEntitlements(orgId);

  const personName = "Gated Player " + suffix;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, photo_path, consent)
    values (${orgId}, ${personName}, '2011-04-03', 'f', ${"photos/" + suffix},
            ${sql.json({ public_name: true, public_photo: true })})
    returning id`;

  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const slugs: { id: string; slug: string }[] = [];
  for (const name of ["Passed Cup " + suffix, "Unpassed Cup " + suffix]) {
    const comp = await createCompetition(auth, {
      name,
      visibility: "unlisted",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: personName,
        seed: 1,
        members: [
          { person_id: personId, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    slugs.push({ id: comp.id, slug: comp.slug });
  }

  // The pass — one competition, for its lifetime (V271).
  await sql`
    insert into competition_passes (competition_id, org_id, pass_key)
    values (${slugs[0]!.id}, ${orgId}, 'pro')`;
  await invalidateOrgEntitlements(orgId);

  return {
    orgId,
    orgSlug,
    personId,
    personName,
    passedId: slugs[0]!.id,
    passedSlug: slugs[0]!.slug,
    unpassedSlug: slugs[1]!.slug,
  };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getPublicPlayer — player-profile gate is competition-scoped", () => {
  it("serves the card on the competition the pass paid for", async () => {
    const scene = await seedScene();
    const data = await getPublicPlayer(scene.orgSlug, scene.passedSlug, scene.personId);
    expect(data).not.toBeNull();
    expect(data!.player.name).toBe(scene.personName);
  });

  it("404s the SAME person on an unpassed competition in the SAME org", async () => {
    const scene = await seedScene();
    // The leak this task exists to prevent: one Event Pass must not light up
    // every other competition in the org. A one-sided test would not see it.
    const passed = await getPublicPlayer(scene.orgSlug, scene.passedSlug, scene.personId);
    expect(passed).not.toBeNull();
    const unpassed = await getPublicPlayer(scene.orgSlug, scene.unpassedSlug, scene.personId);
    expect(unpassed).toBeNull();
  });

  it("denies within the same cache window when the entitlement goes away", async () => {
    const scene = await seedScene();
    expect(await getPublicPlayer(scene.orgSlug, scene.passedSlug, scene.personId)).not.toBeNull();

    // Entitlement changes do not bust `competition:{id}`, so the cached closure
    // above is still warm and still holds the player row. Only a gate evaluated
    // OUTSIDE that closure can deny here.
    await sql`delete from competition_passes where competition_id = ${scene.passedId}`;
    await invalidateOrgEntitlements(scene.orgId);

    expect(await getPublicPlayer(scene.orgSlug, scene.passedSlug, scene.personId)).toBeNull();
  });
});

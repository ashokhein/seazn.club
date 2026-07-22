// Phase 2 pass-scoping sweep — the WRITE half of `sponsors.tiers` and
// `sponsors.monetize`.
//
// Coverage the plan asked for and nobody wrote. What exists today for these two
// keys is:
//   - `lib/__tests__/pass-scoping-guard.test.ts`, which proves the competition
//     id is THREADED into the resolver call, not that anything behaves
//     differently; and
//   - `app/o/[orgSlug]/settings/__tests__/pass-scope-sponsors.test.tsx`, which
//     renders the AFFORDANCE (the tab asks `hasFeatureOnAnyPass`, an org-wide
//     question) and then checks `hasFeature(...)` — the resolver again.
//
// Neither runs `createSponsor` or `createSponsorPackage`, and those are the two
// functions that decide whether a pass holder can actually sell anything. That
// gap matters more here than for the other pass keys, because the settings tab
// deliberately shows these controls to a pass holder ORG-WIDE while enforcement
// stays per-competition: the widened affordance is only honest if the write path
// really does allow the passed competition and really does refuse its sibling.
//
// The matrix makes it a real separation:
//   sponsors.tiers     community=false  event_pass=true
//   sponsors.monetize  community=false  event_pass=true
// so every case asserts BOTH arms in the SAME org. A one-sided test would still
// pass if the grant leaked org-wide, which is the $29 hole in the other
// direction and exactly what the guard cannot see.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createSponsor, createSponsorPackage, patchSponsor } from "../sponsors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Rig {
  orgId: string;
  auth: AuthCtx;
  /** Carries the pass. */
  passedId: string;
  /** Same org, no pass — the control arm. */
  plainId: string;
}

/** A COMMUNITY org (a raw org insert leaves no subscriptions row, and the
 *  resolver's pass arm only fires while the resolved plan is 'community') with
 *  two competitions, one of which holds an Event Pass. */
async function seedOrgWithOnePass(): Promise<Rig> {
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Spon W " + s}, ${"spon-w-" + s})
    returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')
            on conflict (org_id) do update set plan_key = 'community', status = 'active'`;
  const [{ id: passedId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Passed Cup', ${"spon-w-passed-" + s}, 'unlisted') returning id`;
  const [{ id: plainId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Plain Cup', ${"spon-w-plain-" + s}, 'unlisted') returning id`;
  await sql`insert into competition_passes (competition_id, org_id)
            values (${passedId}, ${orgId}) on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
  return {
    orgId,
    passedId,
    plainId,
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

describe.skipIf(!HAS_DB)("sponsor writes resolve their pass keys against the competition being written", () => {
  it("creates a tiered sponsor on the passed competition and 402s on an unpassed one", async () => {
    const rig = await seedOrgWithOnePass();

    const gold = await createSponsor(rig.auth, {
      name: "Big Bank",
      tier: "gold",
      status: "active",
      competition_id: rig.passedId,
    });
    expect(gold.tier).toBe("gold");
    expect(gold.competition_id).toBe(rig.passedId);

    // The pass lifts ONE competition. If `sponsors.tiers` ever resolves
    // org-wide again this stops throwing and the test fails.
    await expect(
      createSponsor(rig.auth, {
        name: "Big Bank",
        tier: "gold",
        status: "active",
        competition_id: rig.plainId,
      }),
    ).rejects.toMatchObject({ status: 402 });

    // The unscoped case is denied too, and deliberately: a NULL competition_id
    // resolves org-wide, so the pass buys a tier ON ITS OWN COMPETITION, never
    // org-wide sponsor tiers (see assertTierAllowed).
    await expect(
      createSponsor(rig.auth, { name: "Org Wide", tier: "gold", status: "active" }),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("promotes a sponsor on the passed competition and refuses the same promotion on a sibling", async () => {
    const rig = await seedOrgWithOnePass();

    // A free, untiered partner on each competition… except that scoping alone
    // is gated, so the plain one has to be created org-wide to exist at all.
    const onPassed = await createSponsor(rig.auth, {
      name: "Corner Shop",
      tier: "partner",
      status: "active",
      competition_id: rig.passedId,
    });
    const orgWide = await createSponsor(rig.auth, {
      name: "Corner Shop 2",
      tier: "partner",
      status: "active",
    });

    const promoted = await patchSponsor(rig.auth, onPassed.id, { tier: "title" });
    expect(promoted.tier).toBe("title");
    // No competition in scope → community's answer → refused, pass or not.
    await expect(
      patchSponsor(rig.auth, orgWide.id, { tier: "title" }),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("creates a priced package on the passed competition and 402s on an unpassed one", async () => {
    const rig = await seedOrgWithOnePass();

    const pkg = await createSponsorPackage(rig.auth, {
      name: "Gold package",
      price_cents: 25_000,
      currency: "gbp",
      tier: "gold",
      competition_id: rig.passedId,
    });
    expect(pkg.price_cents).toBe(25_000);
    expect(pkg.competition_id).toBe(rig.passedId);

    await expect(
      createSponsorPackage(rig.auth, {
        name: "Gold package",
        price_cents: 25_000,
        currency: "gbp",
        tier: "gold",
        competition_id: rig.plainId,
      }),
    ).rejects.toMatchObject({ status: 402 });
  });
});

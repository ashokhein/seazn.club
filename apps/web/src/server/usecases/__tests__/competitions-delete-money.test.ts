// Competition-delete money guards (payments-hardening spec P0-1). A CASCADE
// delete would erase the app's only record of live money — the Event Pass,
// paid registrations, and comp-scoped sponsor orders. deleteCompetition must
// 409 with the archive hint instead. Fully-refunded money still deletes.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Seed a Pro org holding one competition with one (empty) division, and hand
// back the ids the guards key off. Mirrors division-delete.test.ts's local
// seeding: org/subscription/sports via SQL, comp/division via the use-cases.
async function seedCompWithDivision(): Promise<{
  auth: AuthCtx;
  orgId: string;
  compId: string;
  divId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Money " + suffix}, ${"money-" + suffix})
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
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    name: `Cup ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  return { auth, orgId, compId: comp.id, divId: division.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("deleteCompetition money guards", () => {
  it("409s when the competition holds an Event Pass", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_test_pass')`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Event Pass"),
    });
  });

  it("409s when a registration has unrefunded card money", async () => {
    const { auth, compId, divId, orgId } = await seedCompWithDivision();
    await sql`insert into registrations
      (division_id, org_id, status, display_name, contact_email, amount_cents,
       payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
      values (${divId}, ${orgId}, 'paid', 'P', 'p@x.test', 2000, 'pi_reg', 0,
              false, '{}', '[]', ${randomUUID()})`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("409s when a paid sponsor order is scoped to this comp via its package", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    const [pkg] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${compId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
    await sql`insert into sponsor_orders
      (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at)
      values (${orgId}, ${pkg.id}, 'S', 's@x.test', 25000, 'gbp', 'paid', now())`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("still deletes when money is fully refunded", async () => {
    const { auth, compId, divId, orgId } = await seedCompWithDivision();
    await sql`insert into registrations
      (division_id, org_id, status, display_name, contact_email, amount_cents,
       payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
      values (${divId}, ${orgId}, 'withdrawn', 'P', 'p@x.test', 2000, 'pi_reg2', 2000,
              false, '{}', '[]', ${randomUUID()})`;
    await deleteCompetition(auth, compId);
    const [gone] = await sql`select 1 from competitions where id = ${compId}`;
    expect(gone).toBeUndefined();
  });
});

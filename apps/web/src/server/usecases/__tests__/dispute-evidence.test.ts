// Dispute evidence pack (buildDisputeEvidence): one HTML document carrying
// the registration record, the reconstructed confirmation email, the audit
// trail and the entrant's fixtures — fails without the usecase. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { buildDisputeEvidence } from "../registrations";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seed(): Promise<{ owner: AuthCtx; orgId: string; divisionId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`owner-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Evidence Org " + suffix}, ${"ev-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
    on conflict do nothing`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const competition = await createCompetition(owner, {
    name: `Evidence Cup ${suffix}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: DIVISION_CONFIG, eligibility: [],
  });
  return { owner, orgId, divisionId: division.id, compId: competition.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("dispute evidence pack", () => {
  it("bundles registration, receipt reconstruction and activity log", async () => {
    const { owner, orgId, divisionId, compId } = await seed();
    const ref = `SZ-EV${randomUUID().slice(0, 6).toUpperCase()}`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations
        (division_id, org_id, status, ref_code, display_name, contact_email,
         amount_cents, currency, payment_method, payment_intent_id,
         disputed_at, dispute_id, access_token_hash)
      values
        (${divisionId}, ${orgId}, 'confirmed', ${ref}, 'Alex Example',
         'alex@example.com', 2500, 'gbp', 'stripe', 'pi_test_123',
         now(), 'dp_test_1', ${randomUUID()})
      returning id`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${compId}, ${orgId}, 'registration.paid',
              ${sql.json({ registration_id: regId })}, null)`;

    const pack = await buildDisputeEvidence(owner, regId, "https://test.local");
    expect(pack.ref).toBe(ref);
    expect(pack.html).toContain(ref);
    expect(pack.html).toContain("alex@example.com");
    expect(pack.html).toContain("pi_test_123");
    expect(pack.html).toContain("dp_test_1");
    // Receipt reconstruction carries the transactional email body.
    expect(pack.html).toContain("Registration received");
    // Activity log row made it in.
    expect(pack.html).toContain("registration.paid");
    // Export itself is audited.
    const [audit] = await sql`
      select 1 from competition_events
      where type = 'registration.evidence_exported'
        and payload->>'registration_id' = ${regId}`;
    expect(audit).toBeDefined();
  });

  it("refuses another org's registration", async () => {
    const a = await seed();
    const b = await seed();
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations
        (division_id, org_id, status, ref_code, display_name, contact_email,
         amount_cents, currency, payment_method, access_token_hash)
      values (${a.divisionId}, ${a.orgId}, 'confirmed', ${`SZ-XO${randomUUID().slice(0, 6).toUpperCase()}`},
              'Alex', 'a@example.com', 0, 'gbp', 'offline', ${randomUUID()})
      returning id`;
    await expect(buildDisputeEvidence(b.owner, regId, "https://test.local")).rejects.toThrow();
  });
});

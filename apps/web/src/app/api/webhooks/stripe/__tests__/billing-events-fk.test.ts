// Regression for V259 (drop billing_events_org_id_fkey).
//
// billing_events is the Stripe webhook idempotency shell. Its org_id is copied
// straight from external Stripe event metadata, which can reference an org that
// does not exist in this database (a checkout minted against another DB via the
// shared test key, or an org removed by a later baseline). The guard insert
// must NOT throw a foreign-key violation there — otherwise the webhook 5xxs and
// Stripe retry-storms. Pre-V259 this insert raised 23503; post-drop it succeeds.
//
// Real Postgres required; skipped without DATABASE_URL (the CI smoke job runs
// it against its migrated service container).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("billing_events accepts a dangling org_id", () => {
  const insertedIds: string[] = [];

  afterAll(async () => {
    if (!HAS_DB) return;
    if (insertedIds.length) {
      await sql`delete from billing_events where id = any(${insertedIds})`;
    }
    // Mirror the shared-client teardown used by the other DB suites so a later
    // file in this worker gets a fresh connection.
    const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
    const client = globalForDb._sql;
    globalForDb._sql = undefined;
    await client?.end();
  });

  it("inserts an event whose metadata org_id is absent from organizations", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    const danglingOrgId = randomUUID(); // a real uuid, guaranteed not an org
    insertedIds.push(eventId);

    // Precondition: no organizations row exists for this id. This is exactly
    // the state that made the FK fail — a Stripe event referencing an org that
    // lives in another database (or has since been removed).
    const [{ present }] = await sql<{ present: boolean }[]>`
      select exists(select 1 from organizations where id = ${danglingOrgId}) as present`;
    expect(present).toBe(false);

    // Pre-V259: raises "billing_events_org_id_fkey" (SQLSTATE 23503).
    // Post-V259: inserts cleanly.
    await expect(
      sql`insert into billing_events (id, type, org_id, payload)
          values (${eventId}, ${"test.event"}, ${danglingOrgId}, ${sql.json({ regression: "V259" })})`,
    ).resolves.toBeDefined();

    const [row] = await sql<{ org_id: string }[]>`
      select org_id from billing_events where id = ${eventId}`;
    expect(row.org_id).toBe(danglingOrgId);
  });
});

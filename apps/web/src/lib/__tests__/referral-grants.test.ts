// v17 gap #296 — the new-org "welcome" earn grant used to fire immediately
// from createOrgForUser when the org was created via a referral link
// (opts.referredByOrgId). It now fires ONLY once the referred org publishes
// a competition with a division (see publish-earn-gate.test.ts for the full
// wiring) — createOrgForUser's job is reduced to stamping referred_by_org_id
// (T2) so that later signal can find it. This file now proves the NEGATIVE:
// referral stamping still happens, but the grant does not fire here anymore.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { packBalance, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`ref-t3-${randomUUID().slice(0, 8)}@example.com`}, 'Ref T3 Tester', true)
    returning id`;
  return u!.id;
}

describe.skipIf(!HAS_DB)("createOrgForUser referral stamping (#267 T2, grant moved by v17 gap #296)", () => {
  it("opts.referredByOrgId stamps referred_by_org_id but grants NOTHING at creation", async () => {
    const referrer = await createOrgForUser(await seedUser(), "Referrer Co " + randomUUID().slice(0, 6));
    const org = await createOrgForUser(await seedUser(), "Referred Co " + randomUUID().slice(0, 6), {
      referredByOrgId: referrer.id,
    });

    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row?.referred_by_org_id).toBe(referrer.id);

    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger
       where wallet_id = ${walletId} and idempotency_key = ${`earn:referral_welcome:${org.id}`}`;
    expect(n).toBe(0);
  });

  it("no referredByOrgId -> no stamp, no grant (existing callers unchanged)", async () => {
    const org = await createOrgForUser(await seedUser(), "Standalone Co " + randomUUID().slice(0, 6));
    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row?.referred_by_org_id).toBeNull();
  });
});

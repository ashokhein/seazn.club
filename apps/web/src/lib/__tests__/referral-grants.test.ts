// #267 T3 (SPEC-5 §2) — the new-org "welcome" earn grant fired from
// createOrgForUser when the org was created via a referral link
// (opts.referredByOrgId, stamped by T2's referred_by_org_id column). The
// referrer's +20 (fired off the referred org's first paid competition) is
// covered in registrations.test.ts, alongside the existing first_paid harness.
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Force walletIdFor to fail on demand so the best-effort test can exercise
// createOrgForUser's referral try/catch without depending on a org id we
// can't predict ahead of the insert (partial mock, everything else is real —
// same pattern as the stripe/email hoisted mocks in registrations.test.ts).
const creditsFailure = vi.hoisted(() => ({ throwAlways: false }));
vi.mock("@/lib/credits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credits")>();
  return {
    ...actual,
    walletIdFor: async (orgId: string) => {
      if (creditsFailure.throwAlways) throw new Error("forced test failure");
      return actual.walletIdFor(orgId);
    },
  };
});

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { packBalance, REFERRAL_WELCOME_EARN, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;

afterEach(() => {
  creditsFailure.throwAlways = false;
  vi.restoreAllMocks();
});

async function seedUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`ref-t3-${randomUUID().slice(0, 8)}@example.com`}, 'Ref T3 Tester', true)
    returning id`;
  return u!.id;
}

describe.skipIf(!HAS_DB)("createOrgForUser referral welcome grant (#267 T3)", () => {
  it("opts.referredByOrgId grants the new org REFERRAL_WELCOME_EARN once (idempotent per org)", async () => {
    const referrer = await createOrgForUser(await seedUser(), "Referrer Co " + randomUUID().slice(0, 6));
    const org = await createOrgForUser(await seedUser(), "Referred Co " + randomUUID().slice(0, 6), {
      referredByOrgId: referrer.id,
    });

    // createOrgForUser always mints a fresh group-of-one subscription for the
    // new org, so its wallet is that subscription id, not the org id itself.
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(REFERRAL_WELCOME_EARN);

    const [row] = await sql<{ idempotency_key: string }[]>`
      select idempotency_key from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'earn_grant'`;
    expect(row?.idempotency_key).toBe(`earn:referral_welcome:${org.id}`);
  });

  it("no referredByOrgId → no welcome grant (existing callers unchanged)", async () => {
    const org = await createOrgForUser(await seedUser(), "Standalone Co " + randomUUID().slice(0, 6));
    const walletId = await walletIdFor(org.id);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger
       where wallet_id = ${walletId} and idempotency_key = ${`earn:referral_welcome:${org.id}`}`;
    expect(n).toBe(0);
  });

  it("best-effort: a wallet-resolution failure never blocks org creation", async () => {
    const referrer = await createOrgForUser(await seedUser(), "Referrer Co " + randomUUID().slice(0, 6));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    creditsFailure.throwAlways = true;

    const org = await createOrgForUser(await seedUser(), "Referred Co " + randomUUID().slice(0, 6), {
      referredByOrgId: referrer.id,
    });

    // Org creation succeeded despite the (bootstrap AND referral) grants both
    // throwing — org row exists and is stamped.
    const [row] = await sql<{ id: string; referred_by_org_id: string | null }[]>`
      select id, referred_by_org_id from organizations where id = ${org.id}`;
    expect(row?.id).toBe(org.id);
    expect(row?.referred_by_org_id).toBe(referrer.id);
    expect(spy).toHaveBeenCalled();
  });
});

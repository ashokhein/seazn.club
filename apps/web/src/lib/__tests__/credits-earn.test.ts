// AI credit wallet — earn grants (v17 SPEC-5 §2, the PLG "earn free credits"
// loop). recordEarnGrant tops a wallet up with free credits for a growth
// milestone (onboarding completion / first paid competition) into the
// never-expire `pack` bucket, idempotent per (reason, ref) and floored by a
// LIFETIME_EARN_CAP so the loop can never mint unbounded free credits. tryEarnGrant
// is the best-effort hook wrapper (never throws — a grant failure must not fail
// onboarding or the checkout webhook). The referral source is DEFERRED (no
// attribution primitive exists yet), so only onboarding + first_paid are here.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh v17
// schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  FIRST_PAID_EARN,
  LIFETIME_EARN_CAP,
  ONBOARDING_EARN,
  balance,
  grantBalance,
  packBalance,
  recordEarnGrant,
  tryEarnGrant,
  walletIdFor,
} from "@/lib/credits";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Earn ${uniq()}`}, ${`earn-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Seed a raw earn_grant ledger row so a test can put a wallet at/near the
 *  lifetime cap without replaying every milestone. */
async function seedEarned(walletId: string, delta: number): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${delta}, 'earn_grant', 'pack', ${delta}, ${`seed-${uniq()}`})`;
}

describe.skipIf(!HAS_DB)("ai credit wallet — earn grants (SPEC-5 §2)", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("recordEarnGrant", () => {
    it("grants ONBOARDING_EARN once into the never-expire pack bucket, then is idempotent", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();

      const first = await recordEarnGrant(walletId, orgId, "onboarding", orgId, ONBOARDING_EARN);
      expect(first.granted).toBe(ONBOARDING_EARN);
      expect(await packBalance(walletId)).toBe(ONBOARDING_EARN);
      expect(await grantBalance(walletId)).toBe(0); // earned credits are kept, not the resetting bucket

      // Re-completing onboarding (same reason:ref) grants nothing.
      const replay = await recordEarnGrant(walletId, orgId, "onboarding", orgId, ONBOARDING_EARN);
      expect(replay.granted).toBe(0);
      expect(await balance(walletId)).toBe(ONBOARDING_EARN);
    });

    it("first_paid is once-per-ORG (keyed on org, not competition)", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();

      // ref = orgId → idempotency key earn:first_paid:${orgId}.
      const first = await recordEarnGrant(walletId, orgId, "first_paid", orgId, FIRST_PAID_EARN);
      expect(first.granted).toBe(FIRST_PAID_EARN);

      // A SECOND paid competition for the same org — same org-keyed ref — no-ops.
      const second = await recordEarnGrant(walletId, orgId, "first_paid", orgId, FIRST_PAID_EARN);
      expect(second.granted).toBe(0);
      expect(await balance(walletId)).toBe(FIRST_PAID_EARN);
    });

    it("floors at the lifetime cap — grants only up to the cap, never over", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      // Already earned cap − 5; an earn of 10 grants only the remaining 5.
      await seedEarned(walletId, LIFETIME_EARN_CAP - 5);

      const partial = await recordEarnGrant(walletId, orgId, "onboarding", orgId, 10);
      expect(partial.granted).toBe(5);
      expect(await packBalance(walletId)).toBe(LIFETIME_EARN_CAP); // exactly the cap, not over
    });

    it("grants 0 once the wallet is already at the lifetime cap", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      await seedEarned(walletId, LIFETIME_EARN_CAP);

      const atCap = await recordEarnGrant(walletId, orgId, "first_paid", orgId, FIRST_PAID_EARN);
      expect(atCap.granted).toBe(0);
      expect(await packBalance(walletId)).toBe(LIFETIME_EARN_CAP);
    });

    it("the cap is pool-wide across earn sources, not per source", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      await seedEarned(walletId, LIFETIME_EARN_CAP - 3); // 97

      // onboarding takes the last 3 of headroom...
      expect((await recordEarnGrant(walletId, orgId, "onboarding", orgId, 10)).granted).toBe(3);
      // ...so first_paid (a different source) now has no headroom left.
      expect((await recordEarnGrant(walletId, orgId, "first_paid", orgId, 10)).granted).toBe(0);
      expect(await balance(walletId)).toBe(LIFETIME_EARN_CAP);
    });

    it("records an attributable earn_grant row (source in the ledger/history)", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      await recordEarnGrant(walletId, orgId, "onboarding", orgId, ONBOARDING_EARN);

      const [row] = await sql<{ source: string; bucket: string; ref: string; spent_by_org_id: string }[]>`
        select source, bucket, ref, spent_by_org_id from ai_credit_ledger
         where wallet_id = ${walletId}`;
      expect(row?.source).toBe("earn_grant");
      expect(row?.bucket).toBe("pack");
      expect(row?.ref).toBe(orgId);
      expect(row?.spent_by_org_id).toBe(orgId);
    });
  });

  describe("tryEarnGrant (best-effort hook wrapper)", () => {
    it("resolves the wallet via walletIdFor — a grouped org earns into the group pool", async () => {
      const orgId = await seedOrg();
      const subId = await setOrgPlan(orgId, "pro"); // org.subscription_id = subId (the group wallet)
      expect(await walletIdFor(orgId)).toBe(subId);

      const granted = await tryEarnGrant(orgId, "onboarding", ONBOARDING_EARN);
      expect(granted).toBe(ONBOARDING_EARN);
      // Landed on the shared group wallet, not the org's own id.
      expect(await balance(subId)).toBe(ONBOARDING_EARN);
    });

    it("is idempotent per org across calls", async () => {
      const orgId = await seedOrg();
      await setOrgPlan(orgId, "pro");

      expect(await tryEarnGrant(orgId, "first_paid", FIRST_PAID_EARN)).toBe(FIRST_PAID_EARN);
      expect(await tryEarnGrant(orgId, "first_paid", FIRST_PAID_EARN)).toBe(0);
    });

    it("never throws — a grant failure returns 0 (does not fail onboarding/checkout)", async () => {
      // A bogus org id makes walletIdFor throw; tryEarnGrant must swallow it.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const granted = await tryEarnGrant(randomUUID(), "onboarding", ONBOARDING_EARN);
      expect(granted).toBe(0);
      expect(spy).toHaveBeenCalled();
    });
  });
});

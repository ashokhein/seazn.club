// Referral attribution primitive (v17 SPEC-5 §2, issue #267 Task 1). This is
// the FOUNDATION only: a shareable per-org code + its resolver. No attribution
// flow, no grants, no UI yet — those are later tasks in the referral series.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  REFERRAL_CODE_LEN,
  generateReferralCode,
  getOrCreateReferralCode,
  resolveReferralCode,
} from "@/lib/referral";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrgWithOwner(): Promise<{ orgId: string; userId: string; email: string }> {
  const email = `referral-${uniq()}@example.test`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${email}, 'Referral Owner')
    returning id`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Referral ${uniq()}`}, ${`referral-${uniq()}`}, ${user!.id})
    returning id`;
  return { orgId: org!.id, userId: user!.id, email };
}

describe.skipIf(!HAS_DB)("referral code primitive (SPEC-5 §2, #267 Task 1)", () => {
  describe("generateReferralCode", () => {
    it(`returns an ${REFERRAL_CODE_LEN}-char code from the safe alphabet`, () => {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL_CODE_LEN);
      expect(code).toMatch(/^[A-Z2-9]+$/);
      for (const ch of ["0", "O", "1", "I", "L"]) {
        expect(code).not.toContain(ch);
      }
    });

    it("draws fresh randomness — 1000 calls, no duplicates (statistical)", () => {
      const seen = new Set(Array.from({ length: 1000 }, () => generateReferralCode()));
      expect(seen.size).toBe(1000);
    });
  });

  describe("getOrCreateReferralCode", () => {
    it("generates a code, then a second call returns the SAME persisted code", async () => {
      const { orgId } = await seedOrgWithOwner();

      const first = await getOrCreateReferralCode(orgId);
      expect(first).toHaveLength(REFERRAL_CODE_LEN);

      const second = await getOrCreateReferralCode(orgId);
      expect(second).toBe(first);

      const [row] = await sql<{ referral_code: string }[]>`
        select referral_code from organizations where id = ${orgId}`;
      expect(row?.referral_code).toBe(first);
    });

    it("two different orgs get different codes; both resolve back", async () => {
      const a = await seedOrgWithOwner();
      const b = await seedOrgWithOwner();

      const codeA = await getOrCreateReferralCode(a.orgId);
      const codeB = await getOrCreateReferralCode(b.orgId);
      expect(codeA).not.toBe(codeB);

      expect((await resolveReferralCode(codeA))?.orgId).toBe(a.orgId);
      expect((await resolveReferralCode(codeB))?.orgId).toBe(b.orgId);
    });

    it("never overwrites an existing code — pre-set row wins over a concurrent caller", async () => {
      const { orgId } = await seedOrgWithOwner();
      // Run-unique, not a hardcoded literal: referral_code has a partial-unique
      // index shared across ALL orgs, so a fixed preset collides with leftover
      // rows from an earlier run on a persistent test schema (23505).
      const preset = uniq().toUpperCase();
      await sql`update organizations set referral_code = ${preset} where id = ${orgId}`;

      const got = await getOrCreateReferralCode(orgId);
      expect(got).toBe(preset);
    });

    it("best-effort concurrency — two parallel calls for the same org settle on ONE code", async () => {
      const { orgId } = await seedOrgWithOwner();

      const [a, b] = await Promise.all([
        getOrCreateReferralCode(orgId),
        getOrCreateReferralCode(orgId),
      ]);
      expect(a).toBe(b);

      const [row] = await sql<{ referral_code: string }[]>`
        select referral_code from organizations where id = ${orgId}`;
      expect(row?.referral_code).toBe(a);
    });
  });

  describe("resolveReferralCode", () => {
    it("resolves a known code to its org + owner", async () => {
      const { orgId, userId, email } = await seedOrgWithOwner();
      const code = await getOrCreateReferralCode(orgId);

      const resolved = await resolveReferralCode(code);
      expect(resolved).toEqual({ orgId, ownerUserId: userId, ownerEmail: email });
    });

    it("returns null for an unknown code", async () => {
      expect(await resolveReferralCode("NOPE1234")).toBeNull();
    });
  });
});

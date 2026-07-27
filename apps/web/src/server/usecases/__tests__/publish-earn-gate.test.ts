// v17 gap #296 — the onboarding (+10) and referral-welcome (+10) earn grants
// used to fire at signup/onboarding-complete; a scripted signup could farm
// 20 free credits per email address doing nothing else. This wave moves
// both behind a cheap real-usage signal: the org PUBLISHES a competition
// with at least one (non-archived) division. shouldFireGrowthEarnGrants is
// the pure decision (mirrors shouldFireMadePublic); the rest proves the
// wiring against real Postgres. recordEarnGrant/tryEarnGrant themselves
// (idempotency, lifetime cap) are unchanged and stay covered by
// credits-earn.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition, shouldFireGrowthEarnGrants } from "../competitions";
import { createDivision } from "../divisions";
import { createOrgForUser } from "@/lib/auth";
import { packBalance, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pub-earn-${uniq()}@example.com`}, 'Publish Earn Tester', true)
    returning id`;
  return u!.id;
}

async function seedSportFixtures(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
}

async function authFor(orgId: string, userId: string): Promise<AuthCtx> {
  return { orgId, via: "session", userId, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("shouldFireGrowthEarnGrants (pure, v17 gap #296)", () => {
  it("fires on published + >=1 division", () => {
    expect(shouldFireGrowthEarnGrants("published", 1)).toBe(true);
    expect(shouldFireGrowthEarnGrants("published", 2)).toBe(true);
  });
  it("does not fire on published + 0 divisions", () => {
    expect(shouldFireGrowthEarnGrants("published", 0)).toBe(false);
  });
  it("does not fire on any other status, even with divisions", () => {
    expect(shouldFireGrowthEarnGrants("draft", 1)).toBe(false);
    expect(shouldFireGrowthEarnGrants("live", 1)).toBe(false);
    expect(shouldFireGrowthEarnGrants("completed", 1)).toBe(false);
  });
  it("does not fire when the patch didn't change status", () => {
    expect(shouldFireGrowthEarnGrants(null, 1)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("publish-with-division earn gate — wiring (v17 gap #296)", () => {
  it("an org that signs up and does nothing receives no earn_grant rows", async () => {
    const org = await createOrgForUser(await seedUser(), `Idle Org ${uniq()}`);
    const walletId = await walletIdFor(org.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger where wallet_id = ${walletId} and source = 'earn_grant'`;
    expect(n).toBe(0);
  });

  it("a referred org gets NO welcome grant at signup (moved off createOrgForUser)", async () => {
    const referrer = await createOrgForUser(await seedUser(), `Referrer ${uniq()}`);
    const org = await createOrgForUser(await seedUser(), `Referred ${uniq()}`, { referredByOrgId: referrer.id });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("publishing a competition with a division grants ONBOARDING_EARN once, idempotent across re-publishes", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Publisher ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0); // nothing yet — still draft

    await patchCompetition(auth, comp.id, { status: "published" });
    expect(await packBalance(walletId)).toBe(10); // ONBOARDING_EARN

    // Re-publishing (idempotent per-org key) and publishing a SECOND
    // competition with a division both no-op — once per org, not per comp.
    await patchCompetition(auth, comp.id, { status: "published" });
    const comp2 = await createCompetition(auth, { name: "Cup 2", visibility: "private", branding: {} });
    await createDivision(auth, comp2.id, {
      name: "Open",
      slug: `open2-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await patchCompetition(auth, comp2.id, { status: "published" });
    expect(await packBalance(walletId)).toBe(10);
  });

  it("publishing WITHOUT a division grants nothing", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `No Division ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Empty Cup", visibility: "private", branding: {} });

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("a referred org ALSO gets the welcome grant, but only once it publishes with a division", async () => {
    await seedSportFixtures();
    const referrerUserId = await seedUser();
    const referrer = await createOrgForUser(referrerUserId, `Referrer2 ${uniq()}`);
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Referred2 ${uniq()}`, { referredByOrgId: referrer.id });
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    // ONBOARDING_EARN (10) + REFERRAL_WELCOME_EARN (10) = 20. Asserted on the
    // PACK bucket (where earn grants land, SPEC-2 §5.4 D2) — whole-wallet
    // balance() would also include the community bootstrap monthly grant that
    // createOrgForUser gives every new org (grant bucket), which is not under
    // test here.
    expect(await packBalance(walletId)).toBe(20);
  });

  it("archiving every division before publish means no grant (0 non-archived divisions)", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Archived Div ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await sql`update divisions set archived_at = now() where id = ${division.id}`;

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });
});

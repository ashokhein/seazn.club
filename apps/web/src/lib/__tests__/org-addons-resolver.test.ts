// v17 Phase 3 Task 2: org_addons is the ADDITIVE cap axis (SPEC-2 §3, §11.3).
// Where an override REPLACES an int cap, an add-on ADDS to it:
// effective_cap(org, comp) = plan_base + Σ(delta_each·qty) over active/granted
// rows whose target matches. These tests pin that sum into getLimit/withinLimit
// (the single int-reader path) against real Postgres.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// getLimit reads through resolve()'s entitlement cache; disable it so every
// read hits the DB and a just-inserted add-on row is seen immediately (same
// mock as credits-bootstrap-grant.test.ts).
import { vi } from "vitest";
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit, withinLimit } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`addon-${uniq()}@test.local`}, 'Addon Owner', true) returning id`;
  return id;
}

let planBase: number;

beforeAll(async () => {
  if (!HAS_DB) return;
  // The community members.max plan_base (V319 set it to 5) — read, never
  // hard-code, so a later plan re-tune can't silently pass this test.
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = 'members.max'`;
  planBase = row?.int_value ?? 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("org_addons — additive cap resolver", () => {
  it("an active add-on lifts the cap by delta_each·qty and moves withinLimit", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Org");
    const walletId = await walletIdFor(org.id);

    expect(await getLimit(org.id, "members.max")).toBe(planBase);

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${org.id}, 'members.max', 5, 1, 'active')`;

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 5);
    expect((await withinLimit(org.id, "members.max", planBase + 5)).ok).toBe(true);
    expect((await withinLimit(org.id, "members.max", planBase + 6)).ok).toBe(false);
  });

  it("qty multiplies delta_each (qty=3, delta_each=1 => +3)", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Qty Org");
    const walletId = await walletIdFor(org.id);

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${org.id}, 'members.max', 1, 3, 'active')`;

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 3);
  });

  it("a competition-scoped add-on lifts ONLY that comp, never the org-level cap", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Comp Org");
    const walletId = await walletIdFor(org.id);
    const compId = randomUUID();

    await sql`
      insert into org_addons (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${org.id}, ${compId}, 'members.max', 7, 1, 'active')`;

    // Comp-scoped: raised when that comp is in scope...
    expect(await getLimit(org.id, "members.max", compId)).toBe(planBase + 7);
    // ...but an org-level read (no comp) must NOT be lifted by a comp-scoped row.
    expect(await getLimit(org.id, "members.max")).toBe(planBase);
  });

  it("a canceled add-on does NOT count (freeze-not-delete)", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Canceled Org");
    const walletId = await walletIdFor(org.id);

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${org.id}, 'members.max', 9, 1, 'canceled')`;

    // Row stays in the table, but the cap drops back to base.
    expect(await getLimit(org.id, "members.max")).toBe(planBase);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(1);
  });

  it("a group-wide add-on (target_org_id IS NULL) lifts the org", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Groupwide Org");
    const walletId = await walletIdFor(org.id);

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'members.max', 4, 1, 'granted')`;

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 4);
  });

  it("an unlimited (null-int) cap stays unlimited even with an add-on row present", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Addon Unlimited Org");
    const walletId = await walletIdFor(org.id);

    // officials.per_fixture.max is null (unlimited) on community (V319).
    expect(await getLimit(org.id, "officials.per_fixture.max")).toBeNull();

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${org.id}, 'officials.per_fixture.max', 10, 1, 'active')`;

    // Unlimited stays unlimited — an add-on can never turn null into a number.
    expect(await getLimit(org.id, "officials.per_fixture.max")).toBeNull();
  });
});

// Billing groups (V310) with MORE THAN ONE ORG IN THE GROUP.
//
// Every other suite seeds a group of one, which is the one shape that cannot
// fail: a group of one resolves like the old org-keyed subscription did, its cap
// is never counted past one, and a cache invalidation that reaches only the org
// it was handed looks identical to one that reaches the whole group. This file
// exists to hold the multi-org case that the feature is actually for.
//
// The cache is mocked with an in-memory store rather than skipped, because the
// fan-out failure this feature can ship — a sibling org serving the old plan for
// up to the 300s TTL — is invisible without a cache that actually remembers.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => true,
  cacheGet: async (key: string) => {
    const raw = store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  cacheSet: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  },
  cacheDelPattern: async (pattern: string) => {
    const re = new RegExp(
      "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$",
    );
    for (const key of [...store.keys()]) if (re.test(key)) store.delete(key);
  },
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import {
  getLimit,
  hasFeature,
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { activeOrgCount, assertGroupMayHoldAnotherOrg, groupIdsOwnedBy } from "@/lib/billing-group";
import { PaymentRequiredError } from "@/lib/errors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Group {
  payerId: string;
  subId: string;
  orgIds: string[];
}

/**
 * A real group: one subscription, `orgCount` orgs pointing at it, one payer who
 * is a genuine owner member of every org.
 *
 * Deliberately NOT setOrgPlan — that helper mints a group of ONE by design, and
 * a group of one is exactly what this file must not test with.
 */
async function seedGroup(
  plan: string,
  orgCount: number,
  over: { status?: string; statusChangedDaysAgo?: number } = {},
): Promise<Group> {
  const s = uniq();
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`grp-payer-${s}@test.local`}, 'Group Payer', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, status_changed_at)
    values (${payerId}, ${plan}, ${over.status ?? "active"}, ${orgCount},
            ${
              over.statusChangedDaysAgo === undefined
                ? null
                : sql`now() - (${over.statusChangedDaysAgo} * interval '1 day')`
            })
    returning id`;
  const orgIds: string[] = [];
  for (let i = 0; i < orgCount; i++) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Grp ${s} ${i}`}, ${`grp-${s}-${i}`}, ${payerId}, ${subId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${id}, ${payerId}, 'owner')`;
    orgIds.push(id);
  }
  return { payerId, subId, orgIds };
}

beforeEach(() => {
  store.clear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a billing group of three orgs", () => {
  it("resolves the group's plan for EVERY org, and follows a plan change", async () => {
    const { subId, orgIds } = await seedGroup("pro", 3);

    for (const orgId of orgIds) {
      expect(await hasFeature(orgId, "api.access")).toBe(true);
      expect(await getLimit(orgId, "members.max")).toBe(15);
    }

    await sql`update subscriptions set plan_key = 'community' where id = ${subId}`;
    await invalidateGroupEntitlements(subId);

    for (const orgId of orgIds) {
      expect(await hasFeature(orgId, "api.access")).toBe(false);
      expect(await getLimit(orgId, "members.max")).toBe(3);
    }
  });

  it("degrades ALL THREE together when the group lapses, and deletes nothing", async () => {
    // past_due past the 14-day dunning grace: the plan_key on the row is still
    // 'pro' — the degradation happens at read time, for the whole group.
    const { subId, orgIds } = await seedGroup("pro", 3, {
      status: "past_due",
      statusChangedDaysAgo: 15,
    });

    for (const orgId of orgIds) {
      expect(await hasFeature(orgId, "api.access")).toBe(false);
      expect(await getLimit(orgId, "members.max")).toBe(3);
    }

    // The blast radius is reads only. This is the cost the design accepted:
    // one lapsed payer degrades every org in the group — but nothing is removed,
    // so paying up restores all three.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${subId} and deleted_at is null`;
    expect(Number(n)).toBe(3);
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where id = ${subId}`;
    expect(row.plan_key).toBe("pro");
  });
});

describe.skipIf(!HAS_DB)("entitlement cache fan-out across a group", () => {
  it("leaves SIBLINGS STALE when only one org is invalidated, and clears them all when the group is", async () => {
    const { subId, orgIds } = await seedGroup("pro", 3);
    const [first, ...siblings] = orgIds;

    // Warm every org's cache at the group's real plan.
    for (const orgId of orgIds) expect(await hasFeature(orgId, "api.access")).toBe(true);
    expect(orgIds.every((id) => store.has(`ent:${id}:api.access`))).toBe(true);

    await sql`update subscriptions set plan_key = 'community' where id = ${subId}`;

    // The bug this feature can ship: an org-scoped invalidation after a GROUP
    // write. It throws nothing and logs nothing — the siblings simply keep
    // serving the old plan until the 300s TTL runs out.
    await invalidateOrgEntitlements(first!);
    expect(await hasFeature(first!, "api.access")).toBe(false);
    for (const orgId of siblings) {
      expect(await hasFeature(orgId, "api.access")).toBe(true); // stale, silently
    }

    // The group-wide invalidation is what the siblings need.
    await invalidateGroupEntitlements(subId);
    for (const orgId of orgIds) expect(await hasFeature(orgId, "api.access")).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("the group cap counts orgs in the GROUP", () => {
  it("refuses a 6th org in a Pro group of 5 and accepts one in a group of 4", async () => {
    const full = await seedGroup("pro", 5); // orgs.max_owned = 5 on pro
    await expect(assertGroupMayHoldAnotherOrg(full.subId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );

    const room = await seedGroup("pro", 4);
    await expect(assertGroupMayHoldAnotherOrg(room.subId)).resolves.toBeUndefined();
  });

  it("refuses a 2nd org in a community group", async () => {
    const { subId } = await seedGroup("community", 1); // orgs.max_owned = 1
    await expect(assertGroupMayHoldAnotherOrg(subId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it("lets a Pro Plus group hold 10", async () => {
    const nine = await seedGroup("pro_plus", 9);
    await expect(assertGroupMayHoldAnotherOrg(nine.subId)).resolves.toBeUndefined();
    const ten = await seedGroup("pro_plus", 10);
    await expect(assertGroupMayHoldAnotherOrg(ten.subId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });
});

describe.skipIf(!HAS_DB)("the per-user cap and the per-group cap are different guards", () => {
  it("stops a user who spreads free orgs across SEPARATE groups, which no group check can see", async () => {
    // Two community groups of one org each — the shape that satisfies every
    // group-level check while the user sits on two free orgs.
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`spread-${s}@test.local`}, 'Spreader', true) returning id`;
    for (let i = 0; i < 2; i++) {
      const [{ id: subId }] = await sql<{ id: string }[]>`
        insert into subscriptions (owner_user_id, plan_key, status)
        values (${userId}, 'community', 'active') returning id`;
      const [{ id: orgId }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Spread ${s} ${i}`}, ${`spread-${s}-${i}`}, ${userId}, ${subId}) returning id`;
      await sql`insert into org_members (org_id, user_id, role)
                values (${orgId}, ${userId}, 'owner')`;
    }
    expect((await groupIdsOwnedBy(userId)).length).toBe(2);

    // createOrgForUser only consults the group cap when the user owns EXACTLY
    // one group; with two, the new org would land in a brand-new group — and a
    // new group has nothing to exceed, so the group guard waves it through.
    const [{ id: emptyGroup }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'community', 'active') returning id`;
    await expect(assertGroupMayHoldAnotherOrg(emptyGroup)).resolves.toBeUndefined();

    // The per-USER cap is the only thing standing there.
    const { assertMayOwnAnotherOrg, createOrgForUser } = await import("@/lib/auth");
    await expect(assertMayOwnAnotherOrg(userId)).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(createOrgForUser(userId, `Third ${s}`)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });
});

describe.skipIf(!HAS_DB)("suspension is org-scoped, billing is group-scoped", () => {
  it("degrades ONLY the suspended org, leaving its siblings on the paid plan", async () => {
    const { orgIds } = await seedGroup("pro", 3);
    const [suspended, ...siblings] = orgIds;

    await sql`update organizations set status = 'suspended' where id = ${suspended}`;
    await invalidateOrgEntitlements(suspended!); // moderation is an org-scoped write

    expect(await hasFeature(suspended!, "api.access")).toBe(false);
    expect(await getLimit(suspended!, "members.max")).toBe(3);
    for (const orgId of siblings) {
      expect(await hasFeature(orgId, "api.access")).toBe(true);
      expect(await getLimit(orgId, "members.max")).toBe(15);
    }
  });

  it("keeps counting a suspended org toward the bill, and stops counting a deleted one", async () => {
    const { subId, orgIds } = await seedGroup("pro", 3);
    expect(await activeOrgCount(subId)).toBe(3);

    // Moderation must not move money: the customer keeps paying for the slot,
    // so a moderator cannot cut the bill (or hand out a refund) by suspending.
    await sql`update organizations set status = 'suspended' where id = ${orgIds[0]}`;
    expect(await activeOrgCount(subId)).toBe(3);

    // Leaving is the only thing that frees a slot.
    await sql`update organizations set deleted_at = now() where id = ${orgIds[1]}`;
    expect(await activeOrgCount(subId)).toBe(2);
  });
});

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
import {
  activeOrgCount,
  assertGroupMayHoldAnotherOrg,
  assertWithinGroupCap,
  groupIdsOwnedBy,
  groupOrgLimit,
} from "@/lib/billing-group";
import { PaymentRequiredError } from "@/lib/errors";
import { featureReason } from "@/lib/feature-copy";

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

// Pure — no DB, deliberately NOT skipIf(!HAS_DB), so CI's no-database unit job
// runs the offer contract too.
describe("assertWithinGroupCap — purchase offer (v17 gap #293)", () => {
  it("carries { offer: 'extra_org' } when the caller says the plan can buy one", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(5, 5, true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaymentRequiredError);
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toEqual({ offer: "extra_org" });
  });

  it("carries no offer when the plan cannot buy one", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(1, 1, false);
    } catch (err) {
      caught = err;
    }
    // The absence is only meaningful next to a positive discriminator: the
    // refusal itself must still be the SAME 402 on the SAME key, or "no offer"
    // could just as well mean "no refusal happened at all".
    expect(caught).toBeInstanceOf(PaymentRequiredError);
    expect((caught as InstanceType<typeof PaymentRequiredError>).featureKey).toBe("orgs.max_owned");
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });

  it("defaults to no offer when the third argument is omitted (back-compat)", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(5, 5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaymentRequiredError);
    expect((caught as InstanceType<typeof PaymentRequiredError>).featureKey).toBe("orgs.max_owned");
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });

  it("still admits a count under the cap, offer flag or not", () => {
    expect(() => assertWithinGroupCap(4, 5, true)).not.toThrow();
    expect(() => assertWithinGroupCap(99, null, true)).not.toThrow();
  });

  it("the offer it stamps and the reason shipped beside it name ONE remedy", () => {
    // Both halves of the 402 body come from different files, and only a comment
    // held them together. This is the machine-checked half of that pairing —
    // feature-copy.test.ts pins the sentence's own contract.
    let caught: unknown;
    try {
      assertWithinGroupCap(5, 5, true);
    } catch (err) {
      caught = err;
    }
    const err = caught as InstanceType<typeof PaymentRequiredError>;
    expect((err.extra as { offer?: string }).offer).toBe("extra_org");
    expect(featureReason(err.featureKey)).toMatch(/extra organisation/i);
  });
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
      expect(await getLimit(orgId, "members.max")).toBe(5);
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
      expect(await getLimit(orgId, "members.max")).toBe(5);
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

    // createOrgForUser is individual-by-default (#212): every new org mints its
    // OWN community group, so no group cap is ever consulted on this path — a
    // fresh group has nothing to exceed. The per-USER cap is the only guard.
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

  it("the person-cap refusal offers a purchase when an owned org's plan can buy one (v17 gap #293)", async () => {
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`personcap-${s}@test.local`}, 'Person Cap', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${userId}, 'pro', 'active', 5) returning id`;
    for (let i = 0; i < 5; i++) {
      const [{ id: orgId }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Cap ${s} ${i}`}, ${`cap-${s}-${i}`}, ${userId}, ${subId}) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    }

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(userId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toEqual({ offer: "extra_org" });
  });

  it("carries no offer for a community-only spread (nothing to buy)", async () => {
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`personcap-comm-${s}@test.local`}, 'Person Cap Comm', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'community', 'active') returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`CommCap ${s}`}, ${`comm-cap-${s}`}, ${userId}, ${subId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(userId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    // Same discriminator rule as the pure tests: the refusal must still be the
    // orgs.max_owned 402, so "no offer" cannot be satisfied by "no refusal".
    expect((err as InstanceType<typeof PaymentRequiredError>).featureKey).toBe("orgs.max_owned");
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });

  it("carries no offer to an org owner who is not the group's PAYER (v17 gap #293)", async () => {
    // Reachable via transferGroup, which moves subscriptions.owner_user_id and
    // leaves org_members alone: A owns five organisations on a Pro group that B
    // now pays for. The cap still bites A (it bounds a PERSON), but the
    // purchase route would 403 A — requireBillingOwner tests owner_user_id, not
    // org ownership — so offering A the rider just moves the dead end one
    // screen later. The plan here is a perfectly buyable 'pro': the ONLY thing
    // withholding the offer is who pays.
    const s = uniq();
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`orgowner-${s}@test.local`}, 'Org Owner', true) returning id`;
    const [{ id: payerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`grouppayer-${s}@test.local`}, 'Group Payer', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${payerId}, 'pro', 'active', 5) returning id`;
    for (let i = 0; i < 5; i++) {
      const [{ id: orgId }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Xfer ${s} ${i}`}, ${`xfer-${s}-${i}`}, ${ownerId}, ${subId}) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    }

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(ownerId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).featureKey).toBe("orgs.max_owned");
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();

    // The payer, on the SAME group, IS offered one — so the assertion above is
    // pinning the payer gate and not merely a fixture that offers nobody.
    await sql`insert into org_members (org_id, user_id, role)
              select id, ${payerId}, 'owner' from organizations
               where subscription_id = ${subId}`;
    const payerErr = await assertMayOwnAnotherOrg(payerId).then(() => null, (e) => e);
    expect(payerErr).toBeInstanceOf(PaymentRequiredError);
    expect((payerErr as InstanceType<typeof PaymentRequiredError>).extra).toEqual({
      offer: "extra_org",
    });
  });

  it("carries no offer on a plan that has DEGRADED past its grace (v17 gap #293)", async () => {
    // The payer of a Pro group whose dunning ran out 20 days ago. plan_key is
    // still the literal 'pro', so a raw plan_key read would offer a rider the
    // subscription cannot carry; orgPlanKey applies the 14-day past_due grace
    // and answers 'community'. This is what pins the choice of resolver — the
    // rest of the suite never exercises a degraded plan at the cap.
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`lapsed-${s}@test.local`}, 'Lapsed Payer', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, status_changed_at)
      values (${userId}, 'pro', 'past_due', 5, now() - interval '20 days') returning id`;
    for (let i = 0; i < 5; i++) {
      const [{ id: orgId }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Lapsed ${s} ${i}`}, ${`lapsed-${s}-${i}`}, ${userId}, ${subId}) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    }
    // Sanity: the plan row still SAYS pro. Without this the test could pass
    // against a fixture that was never Pro in the first place.
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where id = ${subId}`;
    expect(row.plan_key).toBe("pro");

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(userId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).featureKey).toBe("orgs.max_owned");
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("individual-per-org is the default (#212)", () => {
  it("a second org does NOT join the first — each gets its own group", async () => {
    const { createOrgForUser } = await import("@/lib/auth");
    const s = uniq();
    // Seed a user who owns exactly one PRO group with one org, so the OLD code
    // would auto-join the second org onto it.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`indiv-${s}@test.local`}, 'Indiv', true) returning id`;
    const first = await createOrgForUser(userId, `First ${s}`);
    // Lift the per-user cap so creation is allowed (community caps at 1 org).
    await sql`update subscriptions set plan_key = 'pro'
               where id = (select subscription_id from organizations where id = ${first.id})`;

    const second = await createOrgForUser(userId, `Second ${s}`);

    const [f] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${first.id}`;
    const [g] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${second.id}`;
    expect(g.subscription_id).not.toBe(f.subscription_id); // its OWN group
    const [cnt] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${f.subscription_id} and deleted_at is null`;
    expect(cnt.n).toBe("1"); // first group unchanged
  });
});

describe.skipIf(!HAS_DB)("suspension is org-scoped, billing is group-scoped", () => {
  it("degrades ONLY the suspended org, leaving its siblings on the paid plan", async () => {
    const { orgIds } = await seedGroup("pro", 3);
    const [suspended, ...siblings] = orgIds;

    await sql`update organizations set status = 'suspended' where id = ${suspended}`;
    await invalidateOrgEntitlements(suspended!); // moderation is an org-scoped write

    expect(await hasFeature(suspended!, "api.access")).toBe(false);
    expect(await getLimit(suspended!, "members.max")).toBe(5);
    for (const orgId of siblings) {
      expect(await hasFeature(orgId, "api.access")).toBe(true);
      expect(await getLimit(orgId, "members.max")).toBe(15);
    }
  });

  it("does not let a suspended org shrink the GROUP cap it resolves through", async () => {
    // groupOrgLimit answered the cap through the OLDEST org, and the entitlement
    // resolver maps a suspended org to community — so suspending the eldest of a
    // Pro group made its cap read as 1 (community's orgs.max_owned), the panel
    // showed "Room for 1", and every attach was refused. The group still pays
    // for Pro, so its capacity must not move.
    const { subId, orgIds } = await seedGroup("pro", 3);
    expect(await groupOrgLimit(subId)).toBe(5); // pro

    await sql`update organizations set status = 'suspended' where id = ${orgIds[0]}`;
    await invalidateOrgEntitlements(orgIds[0]!);
    expect(await groupOrgLimit(subId)).toBe(5);

    // Even with EVERY org suspended, the cap is the plan's, not community's —
    // moderation state cannot set a billing limit.
    for (const id of orgIds) {
      await sql`update organizations set status = 'suspended' where id = ${id}`;
      await invalidateOrgEntitlements(id);
    }
    expect(await groupOrgLimit(subId)).toBe(5);
  });

  it("the degenerate (every-org-suspended) branch also honours a purchased add-on (v17 gap #293)", async () => {
    // The NORMAL branch resolves through getLimit, which sums org_addons on top
    // of the plan base. The every-org-suspended branch read plan_entitlements
    // straight and never asked the add-on table at all, so a group that had
    // bought extra organisations reported the bare plan cap the moment its last
    // un-suspended org was suspended. Moderation state must not hide capacity
    // the group is already paying for.
    const { subId, orgIds } = await seedGroup("pro", 2);
    for (const id of orgIds) {
      await sql`update organizations set status = 'suspended' where id = ${id}`;
      await invalidateOrgEntitlements(id);
    }
    expect(await groupOrgLimit(subId)).toBe(5); // pro base, no add-on yet

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${subId}, null, 'orgs.max_owned', 1, 2, 'active')`;

    expect(await groupOrgLimit(subId)).toBe(7);

    // Frozen-not-deleted: a canceled row lifts nothing, exactly as the resolver
    // treats it on the normal branch.
    await sql`update org_addons set status = 'canceled' where wallet_id = ${subId}`;
    expect(await groupOrgLimit(subId)).toBe(5);
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

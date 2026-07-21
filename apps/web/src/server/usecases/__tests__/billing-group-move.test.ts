// Moving organisations between billing groups (spec 2026-07-21 §Operations):
// attach, detach, transfer, and the one quantity rule underneath all three.
//
// This is where the money is. Every test here exists because getting it wrong
// charges a real customer the wrong amount: an attach that does not prorate is
// a free org, an attach that ignores quantity_paid charges twice for a slot
// already bought, a detach that mints a fresh trial_used_at hands out a 14-day
// trial per cycle, and a last-org-out that leaves a live subscription behind
// bills someone for nothing.
//
// The cache is mocked with a real in-memory store rather than skipped: the
// fan-out failure a move can ship — one side of the move serving the other
// group's plan for up to the 300s TTL — is invisible against a no-op cache.
// Stripe is mocked with a stateful double so "no Stripe call was made" is an
// assertion rather than an assumption. Real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

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

// A stateful Stripe double. `cards` is mutated by paymentMethods.detach so the
// has_payment_method re-derivation after a transfer sees what Stripe would
// actually report, instead of a canned answer that would pass either way.
const stripeMock = vi.hoisted(() => {
  const state = {
    itemId: "si_test",
    priceId: "price_tiered_test",
    billingScheme: "tiered" as string,
    quantity: 1,
    cards: [] as { id: string }[],
  };
  const subscriptionsRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: {
      data: [
        {
          id: state.itemId,
          quantity: state.quantity,
          price: { id: state.priceId, billing_scheme: state.billingScheme },
        },
      ],
    },
  }));
  const subscriptionsUpdate = vi.fn(async () => ({}));
  const subscriptionsCancel = vi.fn(async () => ({}));
  const customersUpdate = vi.fn(async () => ({}));
  const customersRetrieve = vi.fn(async () => ({
    deleted: false,
    invoice_settings: { default_payment_method: null },
  }));
  const listPaymentMethods = vi.fn(async () => ({ data: [...state.cards] }));
  const paymentMethodsDetach = vi.fn(async (id: string) => {
    state.cards = state.cards.filter((c) => c.id !== id);
    return {};
  });
  return {
    state,
    subscriptionsRetrieve,
    subscriptionsUpdate,
    subscriptionsCancel,
    customersUpdate,
    customersRetrieve,
    listPaymentMethods,
    paymentMethodsDetach,
    stripe: {
      subscriptions: {
        retrieve: subscriptionsRetrieve,
        update: subscriptionsUpdate,
        cancel: subscriptionsCancel,
      },
      customers: {
        update: customersUpdate,
        retrieve: customersRetrieve,
        listPaymentMethods,
      },
      paymentMethods: { detach: paymentMethodsDetach },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { billedQuantity } from "@/lib/billing-group";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  attachOrgToGroup,
  detachOrgFromGroup,
  syncGroupQuantity,
  transferGroupOwnership,
} from "../billing-groups";
import { processStripeEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(tag: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${tag}-${uniq()}@test.local`}, ${`User ${tag}`}, true) returning id`;
  return id;
}

interface GroupOpts {
  plan?: string;
  status?: string;
  quantityPaid?: number;
  stripeSubId?: string | null;
  stripeCustomerId?: string | null;
  /** Days from now; also what a detach inherits as comped_until. */
  periodEndDays?: number | null;
  trialUsedAt?: string | null;
  cancelAtPeriodEnd?: boolean;
}

async function makeGroup(ownerId: string, opts: GroupOpts = {}): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, trial_used_at, cancel_at_period_end,
       status_changed_at)
    values (${ownerId}, ${opts.plan ?? "pro"}, ${opts.status ?? "active"},
            ${opts.quantityPaid ?? 1}, ${opts.stripeSubId ?? null},
            ${opts.stripeCustomerId ?? null},
            ${
              opts.periodEndDays === undefined || opts.periodEndDays === null
                ? null
                : sql`now() + (${opts.periodEndDays} * interval '1 day')`
            },
            ${opts.trialUsedAt ?? null}, ${opts.cancelAtPeriodEnd ?? false}, now())
    returning id`;
  return id;
}

/** An org in `subId`, owned (org_members role 'owner') by `ownerId`. */
async function makeOrg(subId: string, ownerId: string, role = "owner"): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Move ${s}`}, ${`move-${s}`}, ${ownerId}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${id}, ${ownerId}, ${role})`;
  return id;
}

/** An org on a community group of its own — the only shape that may attach. */
async function makeLooseOrg(ownerId: string): Promise<{ orgId: string; subId: string }> {
  const subId = await makeGroup(ownerId, { plan: "community" });
  return { orgId: await makeOrg(subId, ownerId), subId };
}

const readGroup = async (id: string) =>
  (
    await sql<
      {
        plan_key: string;
        status: string;
        owner_user_id: string;
        quantity_paid: number;
        comped_until: Date | null;
        trial_used_at: Date | null;
        has_payment_method: boolean;
      }[]
    >`select plan_key, status, owner_user_id, quantity_paid, comped_until, trial_used_at,
             has_payment_method from subscriptions where id = ${id}`
  )[0];

const orgGroup = async (orgId: string) =>
  (
    await sql<{ subscription_id: string | null }[]>`
      select subscription_id from organizations where id = ${orgId}`
  )[0]?.subscription_id ?? null;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  stripeMock.state.quantity = 1;
  stripeMock.state.billingScheme = "tiered";
  stripeMock.state.cards = [];
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("attach", () => {
  it("repoints the org, raises the Stripe quantity, prorates, and records quantity_paid", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_attach_" + uniq(),
      stripeCustomerId: "cus_attach_" + uniq(),
      quantityPaid: 1,
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);

    const res = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });

    expect(await orgGroup(joiner.orgId)).toBe(group);
    expect(res).toMatchObject({ quantity: 2, charged: true });
    expect(stripeMock.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    const [, params] = stripeMock.subscriptionsUpdate.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams];
    expect(params.items).toEqual([{ id: stripeMock.state.itemId, quantity: 2 }]);
    // Without create_prorations the extra seat is free until renewal.
    expect(params.proration_behavior).toBe("create_prorations");
    expect((await readGroup(group)).quantity_paid).toBe(2);
  });

  it("costs NOTHING when it reuses a slot the customer has already paid for", async () => {
    // The freed-slot promise: a group that paid for 3 and dropped to 2 may take
    // a third org back at no charge until the period ends. quantity_paid is the
    // only thing that remembers that, and this is the test that makes it true.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_freed_" + uniq(),
      quantityPaid: 3,
    });
    stripeMock.state.quantity = 3;
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);

    const res = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });

    expect(res).toMatchObject({ quantity: 3, charged: false });
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    expect((await readGroup(group)).quantity_paid).toBe(3);
    expect(await billedQuantity(group)).toBe(3);
  });

  it("refuses when the target group is past_due", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      status: "past_due",
      stripeSubId: "sub_due_" + uniq(),
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);
    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group }),
    ).rejects.toThrow(/unpaid invoice/i);
    expect(await orgGroup(joiner.orgId)).toBe(joiner.subId);
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the target group is scheduled to cancel, and does not resume it", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      cancelAtPeriodEnd: true,
      stripeSubId: "sub_cxl_" + uniq(),
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);
    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group }),
    ).rejects.toThrow(/scheduled to cancel/i);
    // An attach must never mutate subscription state as a side effect.
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    const [row] = await sql<{ cancel_at_period_end: boolean }[]>`
      select cancel_at_period_end from subscriptions where id = ${group}`;
    expect(row.cancel_at_period_end).toBe(true);
  });

  it("refuses an org that still pays for its own subscription", async () => {
    // v1 limitation: Stripe cannot move credit between customers, and refunding
    // an annual mid-term could be $130+.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { stripeSubId: "sub_target_" + uniq() });
    await makeOrg(group, payer);
    const ownSub = await makeGroup(payer, { stripeSubId: "sub_own_" + uniq() });
    const orgId = await makeOrg(ownSub, payer);

    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId, subscriptionId: group }),
    ).rejects.toThrow(/pays for its own subscription/i);
    expect(await orgGroup(orgId)).toBe(ownSub);
  });

  it("refuses someone who is not the target group's payer", async () => {
    const payer = await makeUser("payer");
    const stranger = await makeUser("stranger");
    const group = await makeGroup(payer, { stripeSubId: "sub_gate_" + uniq() });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(stranger);
    await expect(
      attachOrgToGroup({ actorUserId: stranger, orgId: joiner.orgId, subscriptionId: group }),
    ).rejects.toThrow(/pays for this billing group/i);
  });

  it("refuses an ADMIN of the org being moved — admin is not a financial role", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { stripeSubId: "sub_admin_" + uniq() });
    await makeOrg(group, payer);
    // The payer is only an admin of the org they are trying to absorb.
    const clubOwner = await makeUser("clubowner");
    const loose = await makeLooseOrg(clubOwner);
    await sql`insert into org_members (org_id, user_id, role)
              values (${loose.orgId}, ${payer}, 'admin')`;
    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId: loose.orgId, subscriptionId: group }),
    ).rejects.toThrow(/being an admin is not enough/i);
  });

  it("refuses once the group is at its plan's org cap", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { plan: "pro", stripeSubId: "sub_cap_" + uniq() });
    for (let i = 0; i < 5; i++) await makeOrg(group, payer); // pro holds 5
    const joiner = await makeLooseOrg(payer);
    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("refuses to raise quantity on a legacy flat price rather than overcharge", async () => {
    // A per_unit price bills quantity x base: a two-org Pro group would pay $38
    // where it owes $28. Fail closed, and BEFORE the org is moved.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { stripeSubId: "sub_flat_" + uniq() });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);
    stripeMock.state.billingScheme = "per_unit";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group }),
      ).rejects.toThrow(/older price/i);
    } finally {
      err.mockRestore();
    }
    expect(await orgGroup(joiner.orgId)).toBe(joiner.subId);
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent: attaching an org already in the group charges nothing again", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_idem_" + uniq(),
      quantityPaid: 1,
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);
    await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });
    stripeMock.state.quantity = 2;
    stripeMock.subscriptionsUpdate.mockClear();

    const again = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });
    expect(again).toMatchObject({ quantity: 2, charged: false });
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("two attaches racing", () => {
  it("cannot both slip past the group's org cap", async () => {
    // Without `select ... for update` on the subscription row both transactions
    // count four orgs, both decide there is room, and a Pro group ends up
    // holding six.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { plan: "pro", stripeSubId: "sub_race_" + uniq() });
    for (let i = 0; i < 4; i++) await makeOrg(group, payer);
    const a = await makeLooseOrg(payer);
    const b = await makeLooseOrg(payer);

    const results = await Promise.allSettled([
      attachOrgToGroup({ actorUserId: payer, orgId: a.orgId, subscriptionId: group }),
      attachOrgToGroup({ actorUserId: payer, orgId: b.orgId, subscriptionId: group }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PaymentRequiredError);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations where subscription_id = ${group}`;
    expect(Number(n)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("detach", () => {
  it("needs no payment and carries the plan, comped_until and trial_used_at", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const trialStamp = "2026-01-02T03:04:05.000Z";
    const group = await makeGroup(payer, {
      plan: "pro_plus",
      stripeSubId: "sub_det_" + uniq(),
      quantityPaid: 2,
      periodEndDays: 30,
      trialUsedAt: trialStamp,
    });
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);
    const [old] = await sql<{ current_period_end: Date }[]>`
      select current_period_end from subscriptions where id = ${group}`;

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });

    expect(res.cancelled_group).toBeNull();
    // Not one Stripe call: detach is free, and the old group's quantity trues up
    // at renewal rather than now.
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionsCancel).not.toHaveBeenCalled();

    const fresh = await readGroup(res.subscription_id);
    expect(await orgGroup(orgId)).toBe(res.subscription_id);
    expect(fresh.owner_user_id).toBe(clubOwner);
    expect(fresh.plan_key).toBe("pro_plus");
    expect(fresh.status).toBe("active");
    expect(fresh.quantity_paid).toBe(1);
    // The period the old payer already paid for, and nothing more.
    expect(fresh.comped_until?.toISOString()).toBe(old.current_period_end.toISOString());
    // Inheriting the stamp is what stops detach farming a fresh 14-day trial.
    expect(fresh.trial_used_at?.toISOString()).toBe(trialStamp);
    // Deferred decrement: the old group keeps its paid slot until renewal.
    expect((await readGroup(group)).quantity_paid).toBe(2);
  });

  it("keeps the plan until the old period ends, then degrades to community", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, {
      plan: "pro",
      stripeSubId: "sub_comp_" + uniq(),
      periodEndDays: 30,
    });
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    // No scheduler flips it — the resolver degrades a lapsed comp at read time.
    await sql`update subscriptions set comped_until = now() - interval '1 day'
               where id = ${res.subscription_id}`;
    store.clear();
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("lets the PAYER evict an org that will not pay", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, { stripeSubId: "sub_evict_" + uniq() });
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: payer, orgId });
    expect(await orgGroup(orgId)).toBe(res.subscription_id);
    // The evicted org lands on its own group, owned by ITS owner — not the payer.
    expect((await readGroup(res.subscription_id)).owner_user_id).toBe(clubOwner);
  });

  it("refuses a bystander who is neither the org's owner nor the payer", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const stranger = await makeUser("stranger");
    const group = await makeGroup(payer, { stripeSubId: "sub_bystander_" + uniq() });
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);
    await expect(
      detachOrgFromGroup({ actorUserId: stranger, orgId }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(await orgGroup(orgId)).toBe(group);
  });

  it("cancels the subscription when the LAST org leaves", async () => {
    // Never leave a live subscription at quantity 0 — the payer would be billed
    // for a group holding nothing.
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const stripeSubId = "sub_last_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, periodEndDays: 10 });
    const orgId = await makeOrg(group, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });
    expect(res.cancelled_group).toBe(group);
    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith(stripeSubId);
    const old = await readGroup(group);
    expect(old.status).toBe("canceled");
    expect(old.plan_key).toBe("community");
    // The org itself is unharmed: it keeps the plan through the paid period.
    expect(await hasFeature(orgId, "api.access")).toBe(true);
  });

  it("refuses when the org already has a billing group of its own", async () => {
    const owner = await makeUser("solo");
    const loose = await makeLooseOrg(owner);
    await expect(
      detachOrgFromGroup({ actorUserId: owner, orgId: loose.orgId }),
    ).rejects.toThrow(/already has its own billing group/i);
  });
});

// ---------------------------------------------------------------------------
// Cache fan-out across a move
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a move invalidates BOTH groups", () => {
  it("drops the cached entitlements of the org that moved and of both groups' members", async () => {
    const payer = await makeUser("payer");
    const target = await makeGroup(payer, { plan: "pro", stripeSubId: "sub_fan_" + uniq() });
    const sibling = await makeOrg(target, payer);
    // The joiner shares its community group with nothing, so the "from" side is
    // represented by the joiner itself; a second org on the target proves the
    // "to" side fans out beyond the org named in the call.
    const joiner = await makeLooseOrg(payer);

    expect(await hasFeature(sibling, "api.access")).toBe(true);
    expect(await hasFeature(joiner.orgId, "api.access")).toBe(false);
    expect(store.has(`ent:${sibling}:api.access`)).toBe(true);
    expect(store.has(`ent:${joiner.orgId}:api.access`)).toBe(true);

    await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: target,
    });

    expect(store.has(`ent:${joiner.orgId}:api.access`)).toBe(false);
    expect(store.has(`ent:${sibling}:api.access`)).toBe(false);
    // And the moved org resolves the new group's plan immediately, not in 300s.
    expect(await hasFeature(joiner.orgId, "api.access")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transfer a group
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("transfer a billing group", () => {
  it("moves the payer and the invoice contact but NOT the card", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const customerId = "cus_xfer_" + uniq();
    const group = await makeGroup(payer, {
      stripeSubId: "sub_xfer_" + uniq(),
      stripeCustomerId: customerId,
    });
    await makeOrg(group, payer);
    await sql`update subscriptions set has_payment_method = true where id = ${group}`;
    stripeMock.state.cards = [{ id: "pm_old_owner" }];

    const res = await transferGroupOwnership({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });

    expect(res.owner_user_id).toBe(heir);
    const [heirRow] = await sql<{ email: string; display_name: string }[]>`
      select email, display_name from users where id = ${heir}`;
    expect(stripeMock.customersUpdate).toHaveBeenCalledWith(
      customerId,
      expect.objectContaining({ email: heirRow.email, name: heirRow.display_name }),
    );
    // The outgoing payer's card does not travel with the group — otherwise the
    // person who just handed it over keeps being charged with no way to stop.
    expect(stripeMock.paymentMethodsDetach).toHaveBeenCalledWith("pm_old_owner");
    expect(stripeMock.state.cards).toHaveLength(0);
    const after = await readGroup(group);
    expect(after.owner_user_id).toBe(heir);
    expect(after.has_payment_method).toBe(false);
    // Billing state itself is untouched: this is not a cancel or a plan change.
    expect(after.plan_key).toBe("pro");
    expect(after.status).toBe("active");
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("refuses anyone but the current payer, and an unknown recipient", async () => {
    const payer = await makeUser("payer");
    const stranger = await makeUser("stranger");
    const group = await makeGroup(payer, { stripeSubId: "sub_xgate_" + uniq() });
    await makeOrg(group, payer);
    await expect(
      transferGroupOwnership({
        actorUserId: stranger,
        subscriptionId: group,
        newOwnerUserId: stranger,
      }),
    ).rejects.toThrow(/pays for this billing group/i);
    await expect(
      transferGroupOwnership({
        actorUserId: payer,
        subscriptionId: group,
        newOwnerUserId: randomUUID(),
      }),
    ).rejects.toThrow(/does not have an account/i);
    expect((await readGroup(group)).owner_user_id).toBe(payer);
  });

  it("leaves Stripe Connect alone — regrouping who pays never touches payouts", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const group = await makeGroup(payer, { stripeCustomerId: "cus_conn_" + uniq() });
    const orgId = await makeOrg(group, payer);
    await sql`update organizations set stripe_account_id = ${"acct_" + uniq()} where id = ${orgId}`;
    const [before] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;

    await transferGroupOwnership({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });

    const [after] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(after.stripe_account_id).toBe(before.stripe_account_id);
  });
});

// ---------------------------------------------------------------------------
// quantity_paid over the billing cycle
// ---------------------------------------------------------------------------

function invoiceEvent(
  subId: string,
  billingReason: Stripe.Invoice.BillingReason,
): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: `in_${uniq()}`,
        billing_reason: billingReason,
        parent: { subscription_details: { subscription: subId } },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("quantity_paid across the cycle", () => {
  it("is trued up to the real org count when the RENEWAL invoice is paid", async () => {
    const payer = await makeUser("payer");
    const stripeSubId = "sub_renew_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, quantityPaid: 3 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);

    await processStripeEvent(invoiceEvent(stripeSubId, "subscription_cycle"));
    expect((await readGroup(group)).quantity_paid).toBe(2);
    expect(await billedQuantity(group)).toBe(2);
  });

  it("is NOT lowered by a mid-period proration invoice — that slot is still paid for", async () => {
    // The freed-slot promise dies here if this fires on any paid invoice: the
    // customer paid for three seats this period and would silently lose one.
    const payer = await makeUser("payer");
    const stripeSubId = "sub_prorate_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, quantityPaid: 3 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);

    await processStripeEvent(invoiceEvent(stripeSubId, "subscription_update"));
    expect((await readGroup(group)).quantity_paid).toBe(3);
  });

  it("never syncs a quantity for a group with no live subscription", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { plan: "community", quantityPaid: 1 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    const res = await syncGroupQuantity(group);
    expect(res).toEqual({ quantity: 2, charged: false });
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    // Nothing was billed, so nothing may claim to have been paid for.
    expect((await readGroup(group)).quantity_paid).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkout.session.completed is group-addressed
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("checkout.session.completed", () => {
  it("links the Stripe customer to the group that PAID, not to the org's current group", async () => {
    // The same defect already fixed for subscription webhooks: once orgs move,
    // `org → organizations.subscription_id` lands on whichever group the org
    // happens to be in now, writing this payer's customer onto another
    // customer's row.
    const payer = await makeUser("payer");
    const paying = await makeGroup(payer, { stripeSubId: "sub_paid_" + uniq() });
    const landed = await makeGroup(payer, { plan: "community" });
    const orgId = await makeOrg(paying, payer);
    await sql`update organizations set subscription_id = ${landed} where id = ${orgId}`;
    const customerId = "cus_checkout_" + uniq();

    await processStripeEvent({
      id: `evt_${uniq()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${uniq()}`,
          customer: customerId,
          metadata: { org_id: orgId, subscription_id: paying },
        },
      },
    } as unknown as Stripe.Event);

    const [rows] = await sql<{ id: string }[]>`
      select id from subscriptions where stripe_customer_id = ${customerId}`;
    expect(rows.id).toBe(paying);
  });
});

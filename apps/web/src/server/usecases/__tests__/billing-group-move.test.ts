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
  // Writes back, deliberately. A double that accepted an update and kept
  // reporting the old quantity made every "the item is now N" assertion a check
  // against a hand-set constant, and no test ever ran a SECOND sync against a
  // truthful item — which is exactly where the interleaving bugs live.
  const subscriptionsUpdate = vi.fn(
    async (_id: string, params: { items?: { quantity?: number }[] }) => {
      const q = params?.items?.[0]?.quantity;
      if (typeof q === "number") state.quantity = q;
      return {};
    },
  );
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
  const setupIntentsCreate = vi.fn(async (params: { customer: string; metadata: unknown }) => ({
    id: "seti_" + Math.random().toString(36).slice(2, 10),
    client_secret: "seti_secret",
    customer: params.customer,
    status: "requires_payment_method",
    payment_method: null,
    metadata: params.metadata,
  }));
  // The offer store: acceptGroupTransfer reads the SetupIntent back from Stripe,
  // so the double has to remember what was created and let a test "confirm" it.
  const intents = new Map<string, Record<string, unknown>>();
  const setupIntentsRetrieve = vi.fn(async (id: string) => {
    const si = intents.get(id);
    if (!si) throw new Error("No such setup intent");
    return si;
  });
  const setupIntentsUpdate = vi.fn(async (id: string, params: { metadata?: unknown }) => {
    const si = intents.get(id);
    if (!si) throw new Error("No such setup intent");
    if (params?.metadata) si.metadata = params.metadata;
    return si;
  });
  const setupIntentsCancel = vi.fn(async (id: string) => {
    const si = intents.get(id);
    if (si) si.status = "canceled";
    return si ?? {};
  });
  return {
    state,
    intents,
    setupIntentsCreate,
    setupIntentsRetrieve,
    setupIntentsUpdate,
    setupIntentsCancel,
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
      setupIntents: {
        create: async (params: { customer: string; metadata: unknown }) => {
          const si = await setupIntentsCreate(params);
          intents.set(si.id, si as unknown as Record<string, unknown>);
          return si;
        },
        retrieve: setupIntentsRetrieve,
        update: setupIntentsUpdate,
        cancel: setupIntentsCancel,
      },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { billedQuantity } from "@/lib/billing-group";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import {
  acceptGroupTransfer,
  attachOrgToGroup,
  detachOrgFromGroup,
  offerGroupTransfer,
  reconcileGroupQuantities,
  revokeGroupTransfer,
  syncGroupQuantity,
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
  /** Days from now. A STAFF COMP sets this and leaves current_period_end null. */
  compedUntilDays?: number | null;
}

async function makeGroup(ownerId: string, opts: GroupOpts = {}): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, comped_until, trial_used_at,
       cancel_at_period_end, status_changed_at)
    values (${ownerId}, ${opts.plan ?? "pro"}, ${opts.status ?? "active"},
            ${opts.quantityPaid ?? 1}, ${opts.stripeSubId ?? null},
            ${opts.stripeCustomerId ?? null},
            ${
              opts.periodEndDays === undefined || opts.periodEndDays === null
                ? null
                : sql`now() + (${opts.periodEndDays} * interval '1 day')`
            },
            ${
              opts.compedUntilDays === undefined || opts.compedUntilDays === null
                ? null
                : sql`now() + (${opts.compedUntilDays} * interval '1 day')`
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

  it("lets an org join a TRIALING group and ride the trial, charging nothing today", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      status: "trialing",
      stripeSubId: "sub_trial_" + uniq(),
      periodEndDays: 14,
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);

    const res = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });

    expect(res.quantity).toBe(2);
    expect(await orgGroup(joiner.orgId)).toBe(group);
    // Entitled the same second, on the group's plan.
    expect(await hasFeature(joiner.orgId, "api.access")).toBe(true);
    // The seat is added to the trialing subscription, and NOTHING is charged
    // today: a trial that has never been billed has no proration to compute, so
    // asserting only `items` here would pass with create_prorations, which is
    // what the code sends for any first seat past quantity_paid.
    const [, params] = stripeMock.subscriptionsUpdate.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams];
    expect(params.items).toEqual([{ id: stripeMock.state.itemId, quantity: 2 }]);
    // No invoice exists yet during a trial, so Stripe raises no charge whatever
    // we ask for; what must hold is that the seat is on the item by trial end.
    expect(stripeMock.state.quantity).toBe(2);
    const [inv] = await sql<{ status: string; trial_end: Date | null }[]>`
      select status, trial_end from subscriptions where id = ${group}`;
    expect(inv.status).toBe("trialing");
  });

  it("refuses a group whose subscription is already cancelled", async () => {
    const payer = await makeUser("payer");
    const dead = await makeGroup(payer, {
      status: "canceled",
      plan: "community",
      stripeSubId: "sub_dead_" + uniq(),
    });
    await makeOrg(dead, payer);
    const joiner = await makeLooseOrg(payer);
    await expect(
      attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: dead }),
    ).rejects.toThrow(/not active/i);
    expect(await orgGroup(joiner.orgId)).toBe(joiner.subId);
  });

  it("leaves a retryable resting state when the quantity call fails", async () => {
    // The org is attached and entitled; only the seat is unbilled. That is loud
    // (502 + log), recoverable by retrying the same attach, and swept by
    // reconcileGroupQuantities if nobody does.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_fail_" + uniq(),
      quantityPaid: 1,
    });
    await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);
    stripeMock.subscriptionsUpdate.mockRejectedValueOnce(new Error("stripe is down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group }),
      ).rejects.toThrow(/could not update your subscription quantity/i);
      expect(await orgGroup(joiner.orgId)).toBe(group);
      expect((await readGroup(group)).quantity_paid).toBe(1);

      // The retry completes it, and charges once — quantity is absolute, never
      // incremented, so the failed attempt cannot double up.
      const again = await attachOrgToGroup({
        actorUserId: payer,
        orgId: joiner.orgId,
        subscriptionId: group,
      });
      expect(again).toMatchObject({ quantity: 2, charged: true });
      expect((await readGroup(group)).quantity_paid).toBe(2);
    } finally {
      err.mockRestore();
    }
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

  it("an attach racing a detach of the SAME org strands no orphan group", async () => {
    // Both rewrite organizations.subscription_id. Without a lock on the ORG row
    // the attach reads the pre-detach group and overwrites the detach's write:
    // the group the detach minted is left holding nothing, is invisible to
    // dropEmptyGroup (which only looks at the group the attach moved FROM), and
    // its owner now holds two groups — after which createOrgForUser joins
    // neither.
    //
    // The interleave is FORCED rather than hoped for. Firing the two at once
    // leaves a window of microseconds between the read and the write and passes
    // either way; holding `for update` on the org row from a transaction of our
    // own makes both operations queue at a point we choose. With the lock they
    // queue BEFORE their read and each sees fresh state; without it they have
    // both already read, block at the UPDATE instead, and the second write
    // clobbers the first.
    const user = await makeUser("racer");
    const home = await makeGroup(user, { plan: "pro", stripeSubId: null });
    const orgId = await makeOrg(home, user);
    await makeOrg(home, user); // a sibling, so detach is legal
    const target = await makeGroup(user, { plan: "pro", stripeSubId: null });
    await makeOrg(target, user);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = sql.begin(async (tx) => {
      await tx`select id from organizations where id = ${orgId} for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));

    const racing = Promise.allSettled([
      attachOrgToGroup({ actorUserId: user, orgId, subscriptionId: target }),
      detachOrgFromGroup({ actorUserId: user, orgId }),
    ]);
    // Long enough for both to have reached their first statement.
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holder;
    await racing;

    // The org ends up in exactly one of the two candidate groups — never a
    // third, and never one that no longer exists. (Counting `subscription_id is
    // not null` proved nothing: neither operation ever nulls that column.)
    const landed = await orgGroup(orgId);
    const [{ n: valid }] = await sql<{ n: string }[]>`
      select count(*)::text as n from subscriptions where id = ${landed}`;
    expect(Number(valid)).toBe(1);
    const [{ n: orphans }] = await sql<{ n: string }[]>`
      select count(*)::text as n from subscriptions s
       where s.owner_user_id = ${user}
         and s.stripe_subscription_id is null and s.stripe_customer_id is null
         and not exists (select 1 from organizations o where o.subscription_id = s.id)`;
    expect(Number(orphans)).toBe(0);
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
    stripeMock.state.quantity = 2;
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);
    const [old] = await sql<{ current_period_end: Date }[]>`
      select current_period_end from subscriptions where id = ${group}`;

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });

    expect(res.cancelled_group).toBeNull();
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
    // The paid slot stays theirs for the rest of the period — no refund, and a
    // re-add before renewal is free.
    expect((await readGroup(group)).quantity_paid).toBe(2);
  });

  it("LOWERS the Stripe quantity, with no proration, so the next invoice is smaller", async () => {
    // Stripe cuts every renewal from the subscription ITEM's quantity and
    // recomputes nothing from our database, so a decrement we never send is one
    // the customer pays for ever: a federation going 8 clubs -> 3 keeps being
    // billed for 8. "No Stripe call on the way down" was not a deferral, it was
    // a permanent overcharge.
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_down_" + uniq(),
      quantityPaid: 3,
      periodEndDays: 30,
    });
    stripeMock.state.quantity = 3;
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);

    await detachOrgFromGroup({ actorUserId: clubOwner, orgId });

    expect(stripeMock.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    const [, params] = stripeMock.subscriptionsUpdate.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams];
    expect(params.items).toEqual([{ id: stripeMock.state.itemId, quantity: 2 }]);
    // "none", never create_prorations: a credit on the way down would be a
    // refund path, and there is deliberately none.
    expect(params.proration_behavior).toBe("none");
    // Local record of what has been paid for does NOT drop here — only the
    // renewal invoice lowers it, which is when those slots are actually spent.
    expect((await readGroup(group)).quantity_paid).toBe(3);
  });

  it("mints COMMUNITY, never an unexpiring paid plan, out of a staff-comped group", async () => {
    // A staff comp sets comped_until and leaves current_period_end NULL
    // (admin-plan.ts never writes one). Inheriting only the period end therefore
    // produced plan_key='pro' with comped_until=null — a plan the resolver's
    // expiry arm can never fire on. Free Pro for ever, self-service, for anyone
    // in a comped group.
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const comped = await makeGroup(payer, {
      plan: "pro",
      stripeSubId: null,
      periodEndDays: null,
      compedUntilDays: 20,
    });
    await makeOrg(comped, payer);
    const orgId = await makeOrg(comped, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });
    const fresh = await readGroup(res.subscription_id);
    expect(fresh.plan_key).toBe("pro");
    expect(fresh.comped_until).not.toBeNull();
    // And it really does expire.
    await sql`update subscriptions set comped_until = now() - interval '1 day'
               where id = ${res.subscription_id}`;
    store.clear();
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("mints COMMUNITY when the old group has no expiry date at all", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const granted = await makeGroup(payer, {
      plan: "pro",
      stripeSubId: null,
      periodEndDays: null,
      compedUntilDays: null,
    });
    await makeOrg(granted, payer);
    const orgId = await makeOrg(granted, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });
    const fresh = await readGroup(res.subscription_id);
    expect(fresh.plan_key).toBe("community");
    expect(fresh.comped_until).toBeNull();
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("does not let a past_due org escape its dunning by leaving", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const dunning = await makeGroup(payer, {
      plan: "pro",
      status: "past_due",
      stripeSubId: "sub_dun_" + uniq(),
      periodEndDays: 30,
    });
    await makeOrg(dunning, payer);
    const orgId = await makeOrg(dunning, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });
    const fresh = await readGroup(res.subscription_id);
    // A payer who has not paid cannot hand on a paid-through period.
    expect(fresh.plan_key).toBe("community");
    expect(fresh.comped_until).toBeNull();
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

/** Confirm an offer's SetupIntent the way Stripe.js would: a card is attached
 *  and the intent succeeds. */
function confirmIntent(setupIntentId: string, paymentMethodId: string): void {
  const si = stripeMock.intents.get(setupIntentId);
  if (!si) throw new Error("no such intent in the double");
  si.status = "succeeded";
  si.payment_method = paymentMethodId;
  stripeMock.state.cards.push({ id: paymentMethodId });
}

describe.skipIf(!HAS_DB)("transfer a billing group", () => {
  it("does NOT hand over a live subscription until the new owner has added a card", async () => {
    // Detaching the outgoing payer's card in one step turns an administrative
    // change into a billing outage over OTHER people's clubs: eight-club
    // federation, treasurer changes in September, annual paid through March,
    // March renewal fails, all eight dun and degrade at day 15 — none of them
    // party to the handover. So phase one only makes an offer.
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

    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });

    expect(offer.status).toBe("pending_card");
    expect(offer.client_secret).toBeTruthy();
    // Nothing has moved, and above all the card is still attached: the
    // subscription is never left unfunded while an offer is outstanding.
    expect((await readGroup(group)).owner_user_id).toBe(payer);
    expect(stripeMock.paymentMethodsDetach).not.toHaveBeenCalled();
    expect(stripeMock.state.cards).toHaveLength(1);
  });

  it("hands over on acceptance: new card first, then the payer, then the old card goes", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const customerId = "cus_acc_" + uniq();
    const group = await makeGroup(payer, {
      stripeSubId: "sub_acc_" + uniq(),
      stripeCustomerId: customerId,
    });
    await makeOrg(group, payer);
    stripeMock.state.cards = [{ id: "pm_old_owner" }];

    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });
    confirmIntent(offer.setup_intent_id!, "pm_heir");

    const res = await acceptGroupTransfer({
      actorUserId: heir,
      setupIntentId: offer.setup_intent_id!,
    });

    expect(res.owner_user_id).toBe(heir);
    expect((await readGroup(group)).owner_user_id).toBe(heir);
    // The heir's card became the default BEFORE the old one was detached.
    const updates = stripeMock.customersUpdate.mock.calls as unknown as [
      string,
      { invoice_settings?: { default_payment_method?: string } },
    ][];
    const defaultCall = updates.findIndex(
      (c) => c[1]?.invoice_settings?.default_payment_method === "pm_heir",
    );
    expect(defaultCall).toBeGreaterThanOrEqual(0);
    expect(stripeMock.paymentMethodsDetach).toHaveBeenCalledWith("pm_old_owner");
    expect(stripeMock.paymentMethodsDetach).not.toHaveBeenCalledWith("pm_heir");
    // The subscription is never cardless: the heir's card is still on file.
    expect(stripeMock.state.cards).toEqual([{ id: "pm_heir" }]);
    // Invoices and dunning email now reach the new payer.
    const [heirRow] = await sql<{ email: string; display_name: string }[]>`
      select email, display_name from users where id = ${heir}`;
    expect(stripeMock.customersUpdate).toHaveBeenCalledWith(
      customerId,
      expect.objectContaining({ email: heirRow.email, name: heirRow.display_name }),
    );
    // And nothing about the subscription itself moved.
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("refuses an acceptance with no card, and one from the wrong person", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const stranger = await makeUser("stranger");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_accgate_" + uniq(),
      stripeCustomerId: "cus_accgate_" + uniq(),
    });
    await makeOrg(group, payer);
    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });

    await expect(
      acceptGroupTransfer({ actorUserId: stranger, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/offered to somebody else/i);
    // Unconfirmed intent: the whole point of the second phase.
    await expect(
      acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/add a card/i);
    expect((await readGroup(group)).owner_user_id).toBe(payer);
  });

  it("refuses a stale acceptance after the group has changed hands", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_stale_" + uniq(),
      stripeCustomerId: "cus_stale_" + uniq(),
    });
    await makeOrg(group, payer);
    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });
    confirmIntent(offer.setup_intent_id!, "pm_heir");
    const other = await makeUser("other");
    await sql`update subscriptions set owner_user_id = ${other} where id = ${group}`;

    await expect(
      acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/changed hands/i);
  });

  it("transfers a group with no Stripe customer immediately — nothing can dun", async () => {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const group = await makeGroup(payer, {
      plan: "community",
      stripeSubId: null,
      stripeCustomerId: null,
    });
    const orgId = await makeOrg(group, payer);
    // The direct path has no acceptance step, so org ownership is the consent.
    await sql`update org_members set role = 'owner' where org_id = ${orgId} and user_id = ${payer}`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir}, 'owner')
              on conflict do nothing`;

    const res = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });
    expect(res.status).toBe("transferred");
    expect((await readGroup(group)).owner_user_id).toBe(heir);
    expect(stripeMock.setupIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses to push a cardless group onto someone with no org in it", async () => {
    const payer = await makeUser("payer");
    const outsider = await makeUser("outsider");
    const group = await makeGroup(payer, { plan: "community", stripeSubId: null });
    await makeOrg(group, payer);
    await expect(
      offerGroupTransfer({
        actorUserId: payer,
        subscriptionId: group,
        newOwnerUserId: outsider,
      }),
    ).rejects.toThrow(/does not own an organisation/i);
  });

  it("refuses anyone but the current payer, and an unknown recipient", async () => {
    const payer = await makeUser("payer");
    const stranger = await makeUser("stranger");
    const group = await makeGroup(payer, { stripeSubId: "sub_xgate_" + uniq() });
    await makeOrg(group, payer);
    await expect(
      offerGroupTransfer({
        actorUserId: stranger,
        subscriptionId: group,
        newOwnerUserId: stranger,
      }),
    ).rejects.toThrow(/pays for this billing group/i);
    await expect(
      offerGroupTransfer({
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
    const group = await makeGroup(payer, {
      stripeSubId: "sub_conn_" + uniq(),
      stripeCustomerId: "cus_conn_" + uniq(),
    });
    const orgId = await makeOrg(group, payer);
    await sql`update organizations set stripe_account_id = ${"acct_" + uniq()} where id = ${orgId}`;
    const [before] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;

    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });
    confirmIntent(offer.setup_intent_id!, "pm_heir");
    await acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! });

    // The transfer must actually have HAPPENED, or "Connect is unchanged" is
    // true of a function that does nothing at all.
    expect((await readGroup(group)).owner_user_id).toBe(heir);
    const [after] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(after.stripe_account_id).toBe(before.stripe_account_id);
    expect(after.stripe_account_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// quantity_paid over the billing cycle
// ---------------------------------------------------------------------------

function invoiceEvent(
  subId: string,
  billingReason: Stripe.Invoice.BillingReason,
  /** Seats the invoice was actually cut for. Stripe puts it on the line, and it
   *  is the ONLY record of what this period was billed at — the subscription
   *  item may already have moved on by the time the webhook is handled. */
  invoicedQuantity?: number,
): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: `in_${uniq()}`,
        billing_reason: billingReason,
        parent: { subscription_details: { subscription: subId } },
        lines: {
          data: invoicedQuantity === undefined ? [] : [{ quantity: invoicedQuantity }],
        },
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
    stripeMock.state.quantity = 2;

    await processStripeEvent(invoiceEvent(stripeSubId, "subscription_cycle", 2));
    expect((await readGroup(group)).quantity_paid).toBe(2);
    expect(await billedQuantity(group)).toBe(2);
  });

  it("records what the invoice was CUT FOR, not what the item says by the time it is handled", async () => {
    // A renewal invoice for 3 seats, then a detach lowers the item to 2 before
    // the webhook is handled — not a microsecond window, since sweepStuckEvents
    // replays events 10+ minutes late by design. Recording 2 here would mean a
    // re-add inside the same period sees `raising` true and charges AGAIN for a
    // seat this period's invoice already paid for.
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const stripeSubId = "sub_late_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, quantityPaid: 3, periodEndDays: 30 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    const leaving = await makeOrg(group, clubOwner);
    stripeMock.state.quantity = 3;

    // Stripe cuts the cycle invoice for 3 …
    const renewal = invoiceEvent(stripeSubId, "subscription_cycle", 3);
    // … the org leaves, dropping the item to 2 …
    await detachOrgFromGroup({ actorUserId: clubOwner, orgId: leaving });
    expect(stripeMock.state.quantity).toBe(2);
    // … and only then does the webhook land.
    await processStripeEvent(renewal);

    // Three seats were paid for this period, whatever the item says now.
    expect((await readGroup(group)).quantity_paid).toBe(3);

    // Which is what makes the re-add free.
    const joiner = await makeLooseOrg(payer);
    stripeMock.subscriptionsUpdate.mockClear();
    const res = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    });
    expect(res.charged).toBe(false);
    const [, params] = stripeMock.subscriptionsUpdate.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams];
    expect(params.proration_behavior).toBe("none");
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
    expect(res).toMatchObject({ quantity: 2, charged: false, synced: false });
    expect(stripeMock.subscriptionsUpdate).not.toHaveBeenCalled();
    // Nothing was billed, so nothing may claim to have been paid for.
    expect((await readGroup(group)).quantity_paid).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("quantity drift", () => {
  it("is billed for when a new org is created straight into a paid group", async () => {
    // createOrgForUser puts the org into the creator's existing group. Its
    // comment used to say callers reconcile the quantity afterwards; none did,
    // so every org created this way was a seat nobody was billed for.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { plan: "pro", stripeSubId: "sub_create_" + uniq() });
    await makeOrg(group, payer);

    const { createOrgForUser } = await import("@/lib/auth");
    await createOrgForUser(payer, `Second ${uniq()}`);

    expect(stripeMock.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    const [, params] = stripeMock.subscriptionsUpdate.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionUpdateParams];
    expect(params.items).toEqual([{ id: stripeMock.state.itemId, quantity: 2 }]);
    expect((await readGroup(group)).quantity_paid).toBe(2);
  });

  it("is swept back into line by the reconcile cron, without issuing a credit", async () => {
    const payer = await makeUser("payer");
    const stripeSubId = "sub_drift_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, quantityPaid: 5 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    // Stripe still holds five seats for three orgs — the shape a failed detach
    // sync leaves behind, and the one that bills for ever if nothing sweeps it.
    stripeMock.state.quantity = 5;

    await reconcileGroupQuantities(2000);
    // Scoped to this group, not a schema-wide counter that other suites' rows
    // satisfy on their own.
    expect(stripeMock.state.quantity).toBe(3);
    // The sweep is schema-wide (other suites' groups share this database), so
    // pick out the call for THIS subscription.
    const call = stripeMock.subscriptionsUpdate.mock.calls.find(
      (c) => (c as unknown as [string])[0] === stripeSubId,
    ) as unknown as [string, Stripe.SubscriptionUpdateParams] | undefined;
    expect(call).toBeTruthy();
    expect(call![1].items).toEqual([{ id: stripeMock.state.itemId, quantity: 3 }]);
    // Lowering must never create_prorations: that is a credit, and there are no
    // refunds in this design.
    expect(call![1].proration_behavior).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Races that postgres.js makes easy to get wrong
// ---------------------------------------------------------------------------
//
// `sql.begin` commits and RELEASES every row lock the moment its callback
// returns. A gate checked inside the block and a mutation performed after it are
// therefore two separate transactions, and every test below existed nowhere
// until that was pointed out. They are forced interleaves, not hopeful ones:
// holding `for update` on the row from the test makes both contenders queue at a
// point we choose.

/**
 * Start `ops` while a row lock is held on the group, so they all queue at the
 * same point, then release and let them run. Returns their settled results.
 */
async function raceUnderGroupLock<T>(
  subscriptionId: string,
  ops: () => Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holder = sql.begin(async (tx) => {
    await tx`select id from subscriptions where id = ${subscriptionId} for update`;
    await held;
  });
  await new Promise((r) => setTimeout(r, 100));
  const racing = Promise.allSettled(ops());
  // Long enough for every contender to have reached its first statement.
  await new Promise((r) => setTimeout(r, 400));
  release();
  await holder;
  return racing;
}

describe.skipIf(!HAS_DB)("concurrent transfers", () => {
  it("cannot both hand the same group away, and the loser detaches nothing", async () => {
    // Two live offers, both accepted at once. Both read owner = A and both pass
    // a gate checked in a transaction that has already committed; then B's
    // detach loop removes every card except B's — deleting C's, which is by then
    // the live subscription's default. That is the federation-wide dunning
    // outage the two-phase design exists to prevent, with no crash involved.
    const payer = await makeUser("payer");
    const b = await makeUser("heirb");
    const c = await makeUser("heirc");
    const customerId = "cus_race_" + uniq();
    const group = await makeGroup(payer, {
      stripeSubId: "sub_race_" + uniq(),
      stripeCustomerId: customerId,
    });
    await makeOrg(group, payer);
    stripeMock.state.cards = [{ id: "pm_payer" }];

    const offerB = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: b,
    });
    const offerC = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: c,
    });
    confirmIntent(offerB.setup_intent_id!, "pm_b");
    confirmIntent(offerC.setup_intent_id!, "pm_c");

    const results = await raceUnderGroupLock(group, () => [
      acceptGroupTransfer({ actorUserId: b, setupIntentId: offerB.setup_intent_id! }),
      acceptGroupTransfer({ actorUserId: c, setupIntentId: offerC.setup_intent_id! }),
    ]);
    // Exactly one may win; the other must have been refused, not silently
    // applied on top.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const owner = (await readGroup(group)).owner_user_id;
    expect([b, c]).toContain(owner);
    // The winner's card is the one still on file, and it is the customer
    // default. The loser must have detached nothing.
    const winnerCard = owner === b ? "pm_b" : "pm_c";
    expect(stripeMock.state.cards.map((x) => x.id)).toContain(winnerCard);
    expect(stripeMock.paymentMethodsDetach).not.toHaveBeenCalledWith(winnerCard);
    // Above all: a live subscription is never left with no card at all.
    expect(stripeMock.state.cards.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("a detach racing an attach into the group it empties", () => {
  it("refuses to cancel a group that is no longer empty", async () => {
    // The window: the detach's re-count commits, an attach queued on that lock
    // proceeds, sees `active`, passes every gate and may be charged — and only
    // then does the cancel fire, leaving a just-paid-for org inside a cancelled
    // group. Closing it means the emptiness test and the status flip have to be
    // the same statement, which is what this asserts directly: a group holding
    // an org is not cancellable, however emptied it looked a moment ago.
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_notempty_" + uniq(),
      periodEndDays: 30,
    });
    const leaving = await makeOrg(group, clubOwner);
    const joiner = await makeLooseOrg(payer);

    // Detach the last org, but slip another one in before the cancel decision:
    // the org row moves under the detach's feet exactly as a racing attach's
    // would, and the group is NOT empty by the time the claim runs.
    const detaching = detachOrgFromGroup({ actorUserId: clubOwner, orgId: leaving });
    await sql`update organizations set subscription_id = ${group} where id = ${joiner.orgId}`;
    const res = await detaching;

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${group} and deleted_at is null`;
    expect(Number(n)).toBe(1);
    // Unconditional assertions — the previous version guarded these behind
    // `if (count > 0)`, so one interleave passed vacuously and the other failed.
    const after = await readGroup(group);
    expect(after.status).toBe("active");
    expect(after.plan_key).toBe("pro");
    expect(res.cancelled_group).toBeNull();
    expect(stripeMock.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("does cancel when it really is empty, and never leaves an org in a dead group", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const stripeSubId = "sub_reallyempty_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, periodEndDays: 30 });
    const leaving = await makeOrg(group, clubOwner);

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId: leaving });
    expect(res.cancelled_group).toBe(group);
    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith(stripeSubId);
    // The invariant across both tests: never `canceled` while holding a live org.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations o join subscriptions s
             on s.id = o.subscription_id
       where s.id = ${group} and s.status = 'canceled' and o.deleted_at is null`;
    expect(Number(n)).toBe(0);
  });

  it("rolls the cancel back when Stripe refuses, leaving the group billable", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, {
      plan: "pro_plus",
      stripeSubId: "sub_rollback_" + uniq(),
      periodEndDays: 30,
      quantityPaid: 2,
    });
    const leaving = await makeOrg(group, clubOwner);
    stripeMock.subscriptionsCancel.mockRejectedValueOnce(new Error("stripe is down"));

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let res;
    try {
      res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId: leaving });
    } finally {
      err.mockRestore();
    }

    // Exactly as it was. A row marked `canceled` while Stripe keeps charging
    // drops out of every live-subscription filter, including the sweep's.
    const after = await readGroup(group);
    expect(after.status).toBe("active");
    expect(after.plan_key).toBe("pro_plus");
    expect(after.quantity_paid).toBe(2);
    expect(res!.cancelled_group).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the connection pool", () => {
  it(
    "survives DB_POOL_MAX concurrent attaches",
    async () => {
      // Every attach holds a pool connection for its transaction. Resolving the
      // plan's org cap from INSIDE that transaction acquires a SECOND connection,
      // and postgres.js queues acquisitions with no timeout — so with the pool
      // default of 5, five concurrent attaches each hold one and wait forever for
      // one that no one can release. That takes the whole process's database
      // access down, not just billing. This test hangs rather than fails if the
      // cap resolution moves back inside the transaction.
      const payer = await makeUser("payer");
      const group = await makeGroup(payer, {
        plan: "pro_plus", // cap 10, so the cap itself is not what refuses
        stripeSubId: "sub_pool_" + uniq(),
      });
      await makeOrg(group, payer);
      const joiners = [];
      for (let i = 0; i < 5; i++) joiners.push(await makeLooseOrg(payer));

      const results = await Promise.allSettled(
        joiners.map((j) =>
          attachOrgToGroup({ actorUserId: payer, orgId: j.orgId, subscriptionId: group }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      const [{ n }] = await sql<{ n: string }[]>`
        select count(*)::text as n from organizations where subscription_id = ${group}`;
      expect(Number(n)).toBe(6);
    },
    15_000,
  );
});

describe.skipIf(!HAS_DB)("creating an org into an existing group", () => {
  it("cannot exceed the group cap when two creations race", async () => {
    // attachOrgToGroup locks the group row and counts under it; createOrgForUser
    // checked the cap outside its transaction and inserted without the lock, so
    // it walked straight around that design and two concurrent calls could land
    // a Pro group with six orgs.
    const user = await makeUser("creator");
    const group = await makeGroup(user, { plan: "pro", stripeSubId: null }); // cap 5
    for (let i = 0; i < 4; i++) await makeOrg(group, user);

    const { createOrgForUser } = await import("@/lib/auth");
    const results = await Promise.allSettled([
      createOrgForUser(user, `Race A ${uniq()}`),
      createOrgForUser(user, `Race B ${uniq()}`),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)
      .toBeInstanceOf(PaymentRequiredError);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${group} and deleted_at is null`;
    expect(Number(n)).toBe(5);
  });
});

describe.skipIf(!HAS_DB)("a live subscription with nothing left to bill", () => {
  it("is cancelled when its last org was SOFT DELETED rather than detached", async () => {
    // Detach cancels the group it empties, but a soft delete goes nowhere near
    // that path. The group was previously selected by the sweep and then skipped
    // for ever on `active < 1` — a live subscription billing a seat for no orgs,
    // with nothing anywhere that would cancel it.
    const payer = await makeUser("payer");
    const stripeSubId = "sub_orphan_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, periodEndDays: 30 });
    const orgId = await makeOrg(group, payer);
    await sql`update organizations set deleted_at = now() where id = ${orgId}`;

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await syncGroupQuantity(group);
    } finally {
      err.mockRestore();
    }

    expect(stripeMock.subscriptionsCancel).toHaveBeenCalledWith(stripeSubId);
    expect((await readGroup(group)).status).toBe("canceled");
  });

  it("stays live and retryable when Stripe REFUSES the cancel", async () => {
    // Marking the row cancelled anyway is the worst outcome: Stripe keeps
    // charging, and the row drops out of every live-subscription filter —
    // including the sweep's — so nothing ever tries again.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_cancelfail_" + uniq(),
      periodEndDays: 30,
    });
    const orgId = await makeOrg(group, payer);
    await sql`update organizations set deleted_at = now() where id = ${orgId}`;
    stripeMock.subscriptionsCancel.mockRejectedValueOnce(new Error("stripe is down"));

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await syncGroupQuantity(group);
    } finally {
      err.mockRestore();
    }

    const after = await readGroup(group);
    expect(after.status).toBe("active");
    expect(after.plan_key).toBe("pro");
    // Still inside the sweep's status filter, so the next run retries it.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from subscriptions
       where id = ${group} and status in ('trialing', 'active', 'past_due')`;
    expect(Number(n)).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("a transfer offer is not a bearer token", () => {
  async function liveOfferedGroup() {
    const payer = await makeUser("payer");
    const heir = await makeUser("heir");
    const group = await makeGroup(payer, {
      stripeSubId: "sub_offer_" + uniq(),
      stripeCustomerId: "cus_offer_" + uniq(),
    });
    await makeOrg(group, payer);
    const offer = await offerGroupTransfer({
      actorUserId: payer,
      subscriptionId: group,
      newOwnerUserId: heir,
    });
    return { payer, heir, group, offer };
  }

  it("can only be used once", async () => {
    // Without this an offer is permanent: A hands the group to B, later takes it
    // back, and B replays the same intent to seize a group full of A's orgs.
    const { heir, group, offer } = await liveOfferedGroup();
    confirmIntent(offer.setup_intent_id!, "pm_heir");
    await acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! });
    expect((await readGroup(group)).owner_user_id).toBe(heir);

    await expect(
      acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/already been used/i);
  });

  it("lapses on its own", async () => {
    const { heir, offer } = await liveOfferedGroup();
    confirmIntent(offer.setup_intent_id!, "pm_heir");
    const si = stripeMock.intents.get(offer.setup_intent_id!)!;
    (si.metadata as Record<string, string>).expires_at = String(
      Math.floor(Date.now() / 1000) - 60,
    );
    await expect(
      acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/expired/i);
  });

  it("can be withdrawn by the payer, and only by the payer", async () => {
    const { payer, heir, group, offer } = await liveOfferedGroup();
    const stranger = await makeUser("stranger");
    await expect(
      revokeGroupTransfer({ actorUserId: stranger, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/pays for this billing group/i);

    await revokeGroupTransfer({ actorUserId: payer, setupIntentId: offer.setup_intent_id! });
    confirmIntent(offer.setup_intent_id!, "pm_heir");
    await expect(
      acceptGroupTransfer({ actorUserId: heir, setupIntentId: offer.setup_intent_id! }),
    ).rejects.toThrow(/withdrawn/i);
    expect((await readGroup(group)).owner_user_id).toBe(payer);
  });
});

describe.skipIf(!HAS_DB)("the sweep's signal survives a failed sync", () => {
  it("stays visible when the renewal's Stripe call fails", async () => {
    // The shape that made drift permanent: set quantity_paid = count(*) first,
    // then fail the Stripe update. The ledger then says the two agree, the
    // sweep's predicate is false for ever, and every later renewal re-bills the
    // wrong seat count and re-arms the equality.
    const payer = await makeUser("payer");
    const stripeSubId = "sub_blind_" + uniq();
    const group = await makeGroup(payer, { stripeSubId, quantityPaid: 5 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    stripeMock.state.quantity = 5;
    stripeMock.subscriptionsUpdate.mockRejectedValueOnce(new Error("stripe is down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processStripeEvent(invoiceEvent(stripeSubId, "subscription_cycle"));
    } finally {
      err.mockRestore();
    }

    // Stripe still holds 5 for 2 orgs, and the ledger must still SAY so.
    expect(stripeMock.state.quantity).toBe(5);
    const after = await readGroup(group);
    expect(after.quantity_paid).toBe(5);

    // Which means the sweep still selects it, and fixes it.
    await reconcileGroupQuantities(2000);
    expect(stripeMock.state.quantity).toBe(2);
  });

  it("relearns what Stripe already holds, so a seat is never charged for twice", async () => {
    // Update succeeded, quantity_paid write did not. If the mirror stays at 1
    // while Stripe holds 2, a detach and re-add makes `raising` true again and
    // the same seat is charged a second time inside one period.
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { stripeSubId: "sub_relearn_" + uniq(), quantityPaid: 1 });
    await makeOrg(group, payer);
    await makeOrg(group, payer);
    stripeMock.state.quantity = 2; // Stripe already billed two seats
    await sql`update subscriptions set quantity_paid = 1 where id = ${group}`;

    const res = await syncGroupQuantity(group);
    expect(res.synced).toBe(false); // nothing to send: Stripe already agrees
    // But the mirror must catch up, or the next re-add double-charges.
    expect((await readGroup(group)).quantity_paid).toBe(2);
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

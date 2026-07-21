// Task 4C — user report 2026-07-20: "I already added the payment method but it
// is still showing *4 days left in your Pro trial. Add a payment method →*".
// Nothing local recorded that a card exists, so the trial banner asked every
// trialing org for one. subscriptions.has_payment_method (V304) mirrors Stripe,
// and EVERY path that can change the answer must write it — this branch has
// been bitten repeatedly by fixing one writer and missing its siblings, so the
// writers are enumerated in one table below and all funnel through
// syncPaymentMethodFlag().
//
// The countdown text is NOT conditional: "4 days left in your Pro trial" stays
// in every case. Only the add-a-card link disappears.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { renderToStaticMarkup } from "react-dom/server";

const stripeMock = vi.hoisted(() => ({
  retrieveCustomer: vi.fn(),
  listPaymentMethods: vi.fn(),
  updateCustomer: vi.fn(),
  retrieveSetupIntent: vi.fn(),
  retrievePaymentMethod: vi.fn(),
  detachPaymentMethod: vi.fn(),
  listInvoices: vi.fn(),
  listTaxIds: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listPaymentMethods: stripeMock.listPaymentMethods,
      update: stripeMock.updateCustomer,
      listTaxIds: stripeMock.listTaxIds,
    },
    setupIntents: { retrieve: stripeMock.retrieveSetupIntent },
    paymentMethods: {
      retrieve: stripeMock.retrievePaymentMethod,
      detach: stripeMock.detachPaymentMethod,
    },
    invoices: { list: stripeMock.listInvoices },
    subscriptions: { retrieve: stripeMock.retrieveSubscription },
    checkout: { sessions: { retrieve: stripeMock.retrieveCheckoutSession } },
  }),
}));
vi.mock("@/lib/auth", () => ({
  getActiveOrgId: vi.fn(),
  requireOrgRole: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn() }));
// Whole-module mock: every invalidator billing.ts reaches for must be present,
// or the reconcile path throws into its own catch and silently returns false.
vi.mock("@/lib/entitlements", () => ({
  invalidateOrgEntitlements: vi.fn(),
  invalidateGroupEntitlements: vi.fn(),
  invalidateEntitlementsForOrgGroup: vi.fn(),
}));

import { sql } from "@/lib/db";
import {
  billingCtaLabel,
  reconcileCheckout,
  syncPaymentMethodFlag,
  syncSubscription,
} from "@/lib/billing";
import {
  getBillingOverview,
  setDefaultPaymentMethod,
  removePaymentMethod,
  staffRemovePaymentMethod,
} from "@/server/usecases/billing-manage";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { BillingBanner } from "@/components/billing-banner";

const HAS_DB = !!process.env.DATABASE_URL;

const CUSTOMER = "cus_pmflag";

async function seedOrg(opts: { trialDays?: number; hasFlag?: boolean } = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pmflag-${suffix}@test.local`}, 'PM Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"PM Org " + suffix}, ${"pm-org-" + suffix}, ${ownerId}) returning id`;
  const trialEnd =
    opts.trialDays === undefined
      ? null
      : new Date(Date.now() + opts.trialDays * 86_400_000 - 3_600_000).toISOString();
  await sql`
    with s as (
      insert into subscriptions
        (owner_user_id, plan_key, status, stripe_customer_id, stripe_subscription_id,
         trial_end, has_payment_method)
      select o.created_by, 'pro', ${opts.trialDays === undefined ? "active" : "trialing"},
             ${CUSTOMER + "_" + suffix}, ${"sub_" + suffix},
             ${trialEnd}, ${opts.hasFlag ?? false}
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations o set subscription_id = s.id from s where o.id = ${orgId}`;
  return orgId;
}

async function flagOf(orgId: string): Promise<boolean | null> {
  const [row] = await sql<{ has_payment_method: boolean }[]>`
    select has_payment_method from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return row ? row.has_payment_method : null;
}

async function customerOf(orgId: string): Promise<string> {
  const [row] = await sql<{ stripe_customer_id: string }[]>`
    select stripe_customer_id from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return row.stripe_customer_id;
}

/** Point the mocked Stripe customer at N cards on file. */
function stripeHasCards(customerId: string, count: number, withDefault = true) {
  stripeMock.retrieveCustomer.mockResolvedValue({
    id: customerId,
    deleted: false,
    invoice_settings: {
      default_payment_method: count > 0 && withDefault ? "pm_default" : null,
    },
  });
  stripeMock.listPaymentMethods.mockResolvedValue({
    data: Array.from({ length: count }, (_, i) => ({ id: `pm_${i}` })),
  });
}

/** The rest of what getBillingOverview fetches — none of it touches the flag. */
function stripeBillingPageRest() {
  stripeMock.listInvoices.mockResolvedValue({ data: [] });
  stripeMock.listTaxIds.mockResolvedValue({ data: [] });
  stripeMock.retrieveSubscription.mockResolvedValue({
    id: "sub_overview",
    status: "trialing",
    discounts: [],
    items: { data: [{ price: { id: "price_unknown_pmflag" } }] },
  });
}

/** Minimal Stripe.Subscription shape syncSubscription reads. */
function stripeSub(over: {
  id: string;
  defaultPaymentMethod?: string | null;
  customer?: unknown;
}): Stripe.Subscription {
  return {
    id: over.id,
    status: "trialing",
    trial_end: Math.floor(Date.now() / 1000) + 4 * 86_400,
    cancel_at_period_end: false,
    currency: "usd",
    default_payment_method: over.defaultPaymentMethod ?? null,
    customer: over.customer ?? "cus_unexpanded",
    items: {
      data: [
        {
          price: { id: "price_unknown_pmflag" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

async function renderBanner(orgId: string): Promise<string> {
  const element = await BillingBanner({ orgId });
  return element ? renderToStaticMarkup(element) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ---------------------------------------------------------------------------
// The user's exact scenario — the banner
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("trial banner vs a card already on file", () => {
  it("keeps the countdown but drops the add-a-card CTA once a card is on file", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    const html = await renderBanner(orgId);
    // The countdown is NOT conditional — the user asked for it to stay.
    expect(html).toContain("4 days left in your Pro trial");
    // …but the org has already done what the CTA asks.
    expect(html).not.toContain("Add a payment method");
    // ("Add a card to keep Pro" is the >7-day arm's copy — asserting its
    //  absence here would pass with or without the fix; the link check below is
    //  the real guard. The >7-day case asserts it where it can appear.)
    expect(html).not.toContain("/settings/billing");
  });

  it("still asks for a card when there is none (unchanged behaviour)", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    const html = await renderBanner(orgId);
    expect(html).toContain("4 days left in your Pro trial");
    expect(html).toContain("Add a payment method");
  });

  it("applies the same rule to the early-trial (>7 days) banner", async () => {
    const withCard = await renderBanner(await seedOrg({ trialDays: 11, hasFlag: true }));
    expect(withCard).toContain("11 days left on your Pro trial");
    expect(withCard).not.toContain("Add a card to keep Pro");

    const without = await renderBanner(await seedOrg({ trialDays: 11, hasFlag: false }));
    expect(without).toContain("11 days left on your Pro trial");
    expect(without).toContain("Add a card to keep Pro");
  });
});

describe("billingCtaLabel takes the flag", () => {
  it("prompts to add a card while trialing WITHOUT one", () => {
    expect(billingCtaLabel("trialing", false)).toBe("Add a card to keep Pro →");
  });

  it("is card management once a trialing org has a card", () => {
    expect(billingCtaLabel("trialing", true)).toBe("Manage payment methods");
  });

  it("is card management once active or past due (in-app, not portal)", () => {
    expect(billingCtaLabel("active", false)).toBe("Manage payment methods");
    expect(billingCtaLabel("past_due", false)).toBe("Manage payment methods");
  });
});

// ---------------------------------------------------------------------------
// THE WRITER SET. One row per path that can change the answer; a new writer
// (e.g. Task 6C's staff-only card removal) is one line here and one
// syncPaymentMethodFlag() call in the production path.
// ---------------------------------------------------------------------------

interface WriterCase {
  name: string;
  /** Cards Stripe reports AFTER the action. */
  cardsAfter: number;
  expected: boolean;
  run(orgId: string): Promise<void>;
}

const WRITERS: WriterCase[] = [
  {
    // The path the user actually hit: add a card in-app during the trial.
    name: "setDefaultPaymentMethod (in-app add card)",
    cardsAfter: 1,
    expected: true,
    async run(orgId) {
      stripeMock.retrieveSetupIntent.mockResolvedValue({
        customer: await customerOf(orgId),
        status: "succeeded",
        payment_method: "pm_new",
      });
      await setDefaultPaymentMethod(orgId, { setupIntentId: "seti_1" });
    },
  },
  {
    name: "removePaymentMethod (last card gone)",
    cardsAfter: 0,
    expected: false,
    async run(orgId) {
      stripeMock.retrievePaymentMethod.mockResolvedValue({
        id: "pm_old",
        customer: await customerOf(orgId),
      });
      stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_old" });
      await removePaymentMethod(orgId, "pm_old");
    },
  },
  {
    // The fifth writer (Task 6C): staff detach an org's card, including its
    // default — the customer-facing removePaymentMethod refuses that, but
    // this is the audited exception (erasure requests, fraud cleanup).
    name: "staffRemovePaymentMethod (staff detaches a card, incl. the default)",
    cardsAfter: 0,
    expected: false,
    async run(orgId) {
      stripeMock.retrievePaymentMethod.mockResolvedValue({
        id: "pm_staff",
        customer: await customerOf(orgId),
        card: { brand: "visa", last4: "4242" },
      });
      stripeMock.detachPaymentMethod.mockResolvedValue({ id: "pm_staff" });
      const [{ id: actorId }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, is_staff, staff_role)
        values (${`pm6c-staff-${orgId}@test.local`}, 'Staff', true, 'superadmin')
        returning id`;
      await staffRemovePaymentMethod(actorId, orgId, "pm_staff", "fraud cleanup");
    },
  },
  {
    name: "payment_method.attached webhook (card added in the Stripe dashboard)",
    cardsAfter: 1,
    expected: true,
    async run(orgId) {
      await processStripeEvent({
        type: "payment_method.attached",
        data: { object: { id: "pm_dash", customer: await customerOf(orgId) } },
      } as unknown as Stripe.Event);
    },
  },
  {
    name: "payment_method.detached webhook (card removed in the Stripe dashboard)",
    cardsAfter: 0,
    expected: false,
    async run(orgId) {
      // A detached PM carries a NULL customer; the link survives only in
      // previous_attributes.
      await processStripeEvent({
        type: "payment_method.detached",
        data: {
          object: { id: "pm_dash", customer: null },
          previous_attributes: { customer: await customerOf(orgId) },
        },
      } as unknown as Stripe.Event);
    },
  },
  {
    name: "customer.updated webhook (default card changed in the dashboard)",
    cardsAfter: 1,
    expected: true,
    async run(orgId) {
      // Gated on invoice_settings — see "customer.updated is chatty" below.
      await processStripeEvent({
        type: "customer.updated",
        data: {
          object: { id: await customerOf(orgId) },
          previous_attributes: {
            invoice_settings: { default_payment_method: null },
          },
        },
      } as unknown as Stripe.Event);
    },
  },
  {
    // The self-heal that removes the need for a V304 backfill: every org that
    // added a card BEFORE the column existed still reads false, and the org's
    // own visit to /settings/billing is what fixes it. Costs no extra Stripe
    // call — getBillingOverview already lists the cards to render them.
    name: "getBillingOverview (billing page render self-heal)",
    cardsAfter: 1,
    expected: true,
    async run(orgId) {
      stripeBillingPageRest();
      const overview = await getBillingOverview(orgId);
      // Not a silent null: the page really rendered on the path under test.
      expect(overview).not.toBeNull();
    },
  },
];

describe.skipIf(!HAS_DB)("has_payment_method — the writer set", () => {
  it.each(WRITERS)("$name writes the flag", async (w) => {
    // Start from the OPPOSITE of the expected value so the assertion cannot
    // pass on the column default.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: !w.expected });
    expect(await flagOf(orgId)).toBe(!w.expected);
    stripeHasCards(await customerOf(orgId), w.cardsAfter);
    await w.run(orgId);
    expect(await flagOf(orgId)).toBe(w.expected);
  });
});

// ---------------------------------------------------------------------------
// The reporter's exact situation: pre-V304 org, card in Stripe, flag stuck
// false. No backfill script — visiting the billing page heals it.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("getBillingOverview self-heals the mirror", () => {
  it("flips a stale false flag to true for an org that already has a card", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    // Banner today: still asking for the card the org has already given.
    expect(await renderBanner(orgId)).toContain("Add a payment method");

    stripeHasCards(await customerOf(orgId), 1);
    stripeBillingPageRest();
    const overview = await getBillingOverview(orgId);

    expect(overview).not.toBeNull();
    expect(await flagOf(orgId)).toBe(true);
    // …and the banner stops asking, without any Stripe call of its own.
    const after = await renderBanner(orgId);
    expect(after).toContain("4 days left in your Pro trial");
    expect(after).not.toContain("Add a payment method");
  });

  it("clears the flag when the org's last card is gone", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    stripeHasCards(await customerOf(orgId), 0);
    stripeBillingPageRest();
    expect(await getBillingOverview(orgId)).not.toBeNull();
    expect(await flagOf(orgId)).toBe(false);
  });

  it("costs no extra Stripe read — it writes from the list it already had", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    stripeHasCards(await customerOf(orgId), 1);
    stripeBillingPageRest();
    await getBillingOverview(orgId);
    // One customer retrieve + one card list for the WHOLE render. A
    // syncPaymentMethodFlag() bolted on top would double both.
    expect(stripeMock.retrieveCustomer).toHaveBeenCalledTimes(1);
    expect(stripeMock.listPaymentMethods).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// customer.updated is chatty: it fires on name/address/tax/balance edits too.
// Only invoice_settings can move the default card, so everything else is a
// cheap ACK rather than a Stripe round trip.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("customer.updated is gated on invoice_settings", () => {
  it("ignores an unrelated customer edit — no Stripe read, mirror untouched", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    stripeHasCards(await customerOf(orgId), 0);
    await processStripeEvent({
      type: "customer.updated",
      data: {
        object: { id: await customerOf(orgId) },
        previous_attributes: { name: "Old Name" },
      },
    } as unknown as Stripe.Event);
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(await flagOf(orgId)).toBe(true);
  });

  it("ignores an event with no previous_attributes at all", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    stripeHasCards(await customerOf(orgId), 0);
    await processStripeEvent({
      type: "customer.updated",
      data: { object: { id: await customerOf(orgId) } },
    } as unknown as Stripe.Event);
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(await flagOf(orgId)).toBe(true);
  });

  it("still acts when invoice_settings changed", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    stripeHasCards(await customerOf(orgId), 0);
    await processStripeEvent({
      type: "customer.updated",
      data: {
        object: { id: await customerOf(orgId) },
        previous_attributes: {
          invoice_settings: { default_payment_method: "pm_old" },
        },
      },
    } as unknown as Stripe.Event);
    expect(stripeMock.retrieveCustomer).toHaveBeenCalled();
    expect(await flagOf(orgId)).toBe(false);
  });

  it("leaves payment_method.attached unconditional (no previous_attributes)", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    stripeHasCards(await customerOf(orgId), 1);
    await processStripeEvent({
      type: "payment_method.attached",
      data: { object: { id: "pm_dash", customer: await customerOf(orgId) } },
    } as unknown as Stripe.Event);
    expect(await flagOf(orgId)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)(
  "syncPaymentMethodFlag (the one writer everything funnels through)",
  () => {
    it("writes true from a live Stripe read and false when the cards are gone", async () => {
      const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
      const customerId = await customerOf(orgId);

      stripeHasCards(customerId, 1);
      expect(await syncPaymentMethodFlag(orgId)).toBe(true);
      expect(await flagOf(orgId)).toBe(true);

      stripeHasCards(customerId, 0);
      expect(await syncPaymentMethodFlag(orgId)).toBe(false);
      expect(await flagOf(orgId)).toBe(false);
    });

    it("counts an attached card even with no customer default set", async () => {
      const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
      stripeHasCards(await customerOf(orgId), 1, /* withDefault */ false);
      expect(await syncPaymentMethodFlag(orgId)).toBe(true);
      expect(await flagOf(orgId)).toBe(true);
    });

    it("leaves the mirror alone when Stripe is unreachable", async () => {
      const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
      stripeMock.retrieveCustomer.mockRejectedValue(new Error("stripe down"));
      stripeMock.listPaymentMethods.mockRejectedValue(new Error("stripe down"));
      expect(await syncPaymentMethodFlag(orgId)).toBeNull();
      expect(await flagOf(orgId)).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// syncSubscription (webhook + reconcile) derives the flag from the Stripe object
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("syncSubscription derives has_payment_method", () => {
  it("sets it from the subscription's own default_payment_method", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    await syncSubscription(orgId, stripeSub({ id: "sub_pm", defaultPaymentMethod: "pm_x" }));
    expect(await flagOf(orgId)).toBe(true);
  });

  it("falls back to the EXPANDED customer default", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    await syncSubscription(
      orgId,
      stripeSub({
        id: "sub_pm2",
        defaultPaymentMethod: null,
        customer: {
          id: "cus_x",
          invoice_settings: { default_payment_method: "pm_cust" },
        },
      }),
    );
    expect(await flagOf(orgId)).toBe(true);
  });

  it("PRESERVES the flag when an expanded customer has no default either", async () => {
    // An expanded customer carries a default-payment-method POINTER, not the
    // card list: a card attached but not yet promoted to default is
    // indistinguishable from no card at all. So this object cannot prove
    // absence, and concluding false here would clear a true flag and re-arm the
    // original bug. Only a card list (syncPaymentMethodFlag) may write false.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    await syncSubscription(
      orgId,
      stripeSub({
        id: "sub_pm3",
        defaultPaymentMethod: null,
        customer: {
          id: "cus_x",
          invoice_settings: { default_payment_method: null },
        },
      }),
    );
    expect(await flagOf(orgId)).toBe(true);
  });

  it("does not INVENT a card either — a false mirror stays false", async () => {
    // The other half of "null": no-evidence must not flip a false flag to true.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    await syncSubscription(
      orgId,
      stripeSub({
        id: "sub_pm3b",
        defaultPaymentMethod: null,
        customer: {
          id: "cus_x",
          invoice_settings: { default_payment_method: null },
        },
      }),
    );
    expect(await flagOf(orgId)).toBe(false);
  });

  it("PRESERVES a true flag when the Stripe object cannot answer (unexpanded)", async () => {
    // The user's regression in waiting: the 14-day no-card trial leaves the
    // SUBSCRIPTION's default_payment_method null even after a card is added
    // (the card lands on the CUSTOMER). With the customer unexpanded, a
    // webhook must not conclude "no card" and re-arm the banner.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    await syncSubscription(orgId, stripeSub({ id: "sub_pm4", defaultPaymentMethod: null }));
    expect(await flagOf(orgId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The EIGHTH writer: linking a Stripe customer. The mirror means "cards on
// customer X", so a cancel-then-rebuy that lands the org on a NEW customer must
// not carry the old customer's `true` into a fresh no-card trial — that inverts
// the reported bug into a banner that never asks and a silent trial expiry.
// ---------------------------------------------------------------------------

async function updatedAtOf(orgId: string): Promise<string> {
  const [row] = await sql<{ updated_at: string }[]>`
    select updated_at from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return new Date(row.updated_at).toISOString();
}

/** Cancel the org's subscription the way Stripe would, leaving the dead id. */
async function cancelSubscription(orgId: string) {
  await sql`
    update subscriptions set status = 'canceled', trial_end = null
    where id = (select subscription_id from organizations where id = ${orgId})`;
}

describe.skipIf(!HAS_DB)("cancel → re-buy lands on a NEW Stripe customer", () => {
  it("clears the inherited flag on the checkout.session.completed webhook", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    const customerA = await customerOf(orgId);
    expect(await flagOf(orgId)).toBe(true);
    await cancelSubscription(orgId);

    // Re-buy: brand new customer, NO card on it (the 14-day no-card trial).
    const customerB = `${customerA}_rebuy`;
    stripeHasCards(customerB, 0);
    await processStripeEvent({
      type: "checkout.session.completed",
      data: { object: { customer: customerB, metadata: { org_id: orgId } } },
    } as unknown as Stripe.Event);

    expect(await customerOf(orgId)).toBe(customerB);
    // Customer B's cards, not customer A's.
    expect(await flagOf(orgId)).toBe(false);

    // …and the fresh trial's banner does ask for a card.
    await syncSubscription(orgId, stripeSub({ id: "sub_rebuy", defaultPaymentMethod: null }));
    const html = await renderBanner(orgId);
    expect(html).toContain("4 days left in your Pro trial");
    expect(html).toContain("Add a payment method");
  });

  it("clears it on the reconcile-on-return path too", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    const customerB = `${await customerOf(orgId)}_reconcile`;
    await cancelSubscription(orgId);
    stripeHasCards(customerB, 0);
    stripeMock.retrieveCheckoutSession.mockResolvedValue({
      id: "cs_rebuy",
      customer: customerB,
      metadata: { org_id: orgId },
      subscription: stripeSub({
        id: "sub_reconcile",
        defaultPaymentMethod: null,
      }),
    });

    expect(await reconcileCheckout(orgId, "cs_rebuy")).toBe(true);
    expect(await customerOf(orgId)).toBe(customerB);
    expect(await flagOf(orgId)).toBe(false);
    expect(await renderBanner(orgId)).toContain("Add a payment method");
  });

  it("re-derives rather than blindly clearing: a card-collecting re-buy stays true", async () => {
    // trialDays 0 checkout charges at once, so customer B really does have the
    // card. A hard `false` would ask an org that just paid to add the card it
    // just added.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    const customerB = `${await customerOf(orgId)}_paid`;
    stripeHasCards(customerB, 1);
    await processStripeEvent({
      type: "checkout.session.completed",
      data: { object: { customer: customerB, metadata: { org_id: orgId } } },
    } as unknown as Stripe.Event);
    expect(await flagOf(orgId)).toBe(true);
  });

  it("leaves the mirror and updated_at alone when the customer is UNCHANGED", async () => {
    // The common case: reconcile and the webhook both link the same customer.
    // A renewal must not disturb the flag or the sibling timestamp.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    const customerA = await customerOf(orgId);
    await sql`update subscriptions set updated_at = '2020-01-01T00:00:00Z' where id = (select subscription_id from organizations where id = ${orgId})`;
    stripeHasCards(customerA, 0); // would clear the flag if we re-derived
    await processStripeEvent({
      type: "checkout.session.completed",
      data: { object: { customer: customerA, metadata: { org_id: orgId } } },
    } as unknown as Stripe.Event);
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(await flagOf(orgId)).toBe(true);
    expect(await updatedAtOf(orgId)).toBe("2020-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// writePaymentMethodFlag bumps updated_at ONLY on a real change.
// needsRenewalResync reads sibling columns off this row, so the cleverness is
// pinned rather than left to be rediscovered.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("has_payment_method writes and updated_at", () => {
  it("does NOT touch updated_at when the value is unchanged", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    await sql`update subscriptions set updated_at = '2020-01-01T00:00:00Z' where id = (select subscription_id from organizations where id = ${orgId})`;
    stripeHasCards(await customerOf(orgId), 0);
    expect(await syncPaymentMethodFlag(orgId)).toBe(false);
    expect(await updatedAtOf(orgId)).toBe("2020-01-01T00:00:00.000Z");
  });

  it("DOES bump updated_at when the value actually changes", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: false });
    await sql`update subscriptions set updated_at = '2020-01-01T00:00:00Z' where id = (select subscription_id from organizations where id = ${orgId})`;
    stripeHasCards(await customerOf(orgId), 1);
    expect(await syncPaymentMethodFlag(orgId)).toBe(true);
    expect(await updatedAtOf(orgId)).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

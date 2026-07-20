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
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listPaymentMethods: stripeMock.listPaymentMethods,
      update: stripeMock.updateCustomer,
    },
    setupIntents: { retrieve: stripeMock.retrieveSetupIntent },
    paymentMethods: {
      retrieve: stripeMock.retrievePaymentMethod,
      detach: stripeMock.detachPaymentMethod,
    },
  }),
}));
vi.mock("@/lib/auth", () => ({
  getActiveOrgId: vi.fn(),
  requireOrgRole: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ invalidateOrgEntitlements: vi.fn() }));

import { sql } from "@/lib/db";
import { billingCtaLabel, syncPaymentMethodFlag, syncSubscription } from "@/lib/billing";
import { setDefaultPaymentMethod, removePaymentMethod } from "@/server/usecases/billing-manage";
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
    insert into subscriptions
      (org_id, plan_key, status, stripe_customer_id, stripe_subscription_id,
       trial_end, has_payment_method)
    values (${orgId}, 'pro', ${opts.trialDays === undefined ? "active" : "trialing"},
            ${CUSTOMER + "_" + suffix}, ${"sub_" + suffix},
            ${trialEnd}, ${opts.hasFlag ?? false})`;
  return orgId;
}

async function flagOf(orgId: string): Promise<boolean | null> {
  const [row] = await sql<{ has_payment_method: boolean }[]>`
    select has_payment_method from subscriptions where org_id = ${orgId}`;
  return row ? row.has_payment_method : null;
}

async function customerOf(orgId: string): Promise<string> {
  const [row] = await sql<{ stripe_customer_id: string }[]>`
    select stripe_customer_id from subscriptions where org_id = ${orgId}`;
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
    expect(html).not.toContain("Add a card to keep Pro");
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
      await processStripeEvent({
        type: "customer.updated",
        data: { object: { id: await customerOf(orgId) } },
      } as unknown as Stripe.Event);
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

describe.skipIf(!HAS_DB)("syncPaymentMethodFlag (the one writer everything funnels through)", () => {
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
});

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
        customer: { id: "cus_x", invoice_settings: { default_payment_method: "pm_cust" } },
      }),
    );
    expect(await flagOf(orgId)).toBe(true);
  });

  it("clears it when an expanded customer has no default either", async () => {
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    await syncSubscription(
      orgId,
      stripeSub({
        id: "sub_pm3",
        defaultPaymentMethod: null,
        customer: { id: "cus_x", invoice_settings: { default_payment_method: null } },
      }),
    );
    expect(await flagOf(orgId)).toBe(false);
  });

  it("PRESERVES a true flag when the Stripe object cannot answer", async () => {
    // The user's regression in waiting: the 14-day no-card trial leaves the
    // SUBSCRIPTION's default_payment_method null even after a card is added
    // (the card lands on the CUSTOMER). With the customer unexpanded, a
    // webhook must not conclude "no card" and re-arm the banner.
    const orgId = await seedOrg({ trialDays: 4, hasFlag: true });
    await syncSubscription(orgId, stripeSub({ id: "sub_pm4", defaultPaymentMethod: null }));
    expect(await flagOf(orgId)).toBe(true);
  });
});

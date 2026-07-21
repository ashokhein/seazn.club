// LIVE contract probe for `automatic_tax` + `tax_id_collection` on an EXISTING
// customer — NOT a unit test. Same reasoning as billing-proration.live.test.ts:
// a param object cannot tell you the API rejects it, only the API can.
//
// The question: both checkout builders set `automatic_tax: { enabled: true }`
// and `tax_id_collection: { enabled: true }`. Once linkStripeCustomer runs on
// the Event Pass path too, EVERY returning buyer's checkout carries an existing
// `customer` whose address Stripe has never collected. Does Stripe refuse?
//
// Skipped unless BILLING_LIVE=1. Runs against Stripe TEST mode (the key in
// .env.local is rk_test_*) and creates + deletes a throwaway customer and
// expires the sessions it opens; no real money moves. Run:
//   BILLING_LIVE=1 DATABASE_URL=... STRIPE_SECRET_KEY=... npx vitest run \
//     --root apps/web src/lib/__tests__/billing-automatic-tax.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { buildEmbeddedCheckoutParams, buildPassCheckoutParams } from "@/lib/billing";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;

// The Event Pass price (2900 usd, one_time, currency_options aud/eur/gbp/inr/usd)
// and the Pro monthly price, in Stripe TEST mode. Hard-coded rather than read
// from `plans`, because a test DB that has run the pass-checkout unit suite
// carries the stub id 'price_test_pass' and the probe would 400 on the price
// instead of on the parameter under test.
const PASS_PRICE = "price_1TukMvAy22H0xqqxw3aoT3Dr";
const PRO_MONTHLY_PRICE = "price_1TukMrAy22H0xqqxAJdWyaJZ";

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// PROBE RESULT — recorded 2026-07-21 against LIVE Stripe test mode,
// stripe-node v22. Customer created with an email and NOTHING else
// (`address: null`) — exactly what linkStripeCustomer leaves behind.
// Error text is VERBATIM.
//
// (A) automatic_tax on, existing customer, NO `customer_update`
//     — both mode:"payment" (pass) and mode:"subscription" (Pro):
//
//       message: Automatic tax calculation in Checkout requires a valid address
//                on the Customer. Add a valid address to the Customer or set
//                `customer_update[address]` to 'auto' to save the billing
//                address entered in Checkout to the Customer.
//       type: StripeInvalidRequestError
//       code: customer_tax_location_invalid
//       param: undefined
//       statusCode: 400
//
// (B) with `customer_update: { address: "auto" }` — SECOND, DIFFERENT 400,
//     again on both modes. `address` alone is NOT the fix:
//
//       message: Tax ID collection requires updating business name on the
//                customer. To enable tax ID collection for an existing
//                customer, please set `customer_update[name]` to `auto`.
//       type: StripeInvalidRequestError
//       code: undefined
//       param: undefined
//       statusCode: 400
//
// (C) with `customer_update: { address: "auto", name: "auto" }` — SUCCESS on
//     both modes: session status "open",
//     automatic_tax { enabled: true, status: "requires_location_inputs" }.
//
// (D) `customer_update` sent WITHOUT `customer` (the first-purchase path, which
//     sends customer_email instead) — 400:
//
//       message: `customer_update` can only be used with `customer` or
//                `customer_account`.
//       statusCode: 400
//
// (E) a first-purchase pass session (customer_email, no customer_update) with
//     automatic_tax on and invoice_creation on — SUCCESS, and the invoice
//     description round-trips:
//       invoice_creation.invoice_data.description = "Event Pass — Probe Cup"
//
// (F) The decisive control, run because the received wisdom is that
//     `customer_update[address]` only decides WHICH address is taxed rather
//     than avoiding an error. An existing customer with a FULL saved address
//     AND a name (line1/city/postal_code/country=GB, name "Addressed Buyer"),
//     automatic_tax on, no customer_update — STILL a 400:
//
//       message: Tax ID collection requires updating business name on the
//                customer. To enable tax ID collection for an existing
//                customer, please set `customer_update[name]` to `auto`.
//       statusCode: 400
//
//     Same 400 for an addressed customer with a NULL name. So the address
//     guidance is beside the point here: `tax_id_collection: { enabled: true }`
//     — which BOTH builders already set — refuses EVERY existing customer
//     without `customer_update[name]`, saved address or not. `automatic_tax`
//     contributes the separate address-shaped 400 in (A). Two independent
//     reasons, one parameter.
//
// NOTE, deliberately not asserted: the successful sessions come back
// `automatic_tax.status: "requires_location_inputs"` and
// `total_details.amount_tax: 0`. The account has tax settings active but ZERO
// tax registrations, so Stripe Tax calculates nothing anywhere — the account's
// current state, not a defect in this change, and out of scope here. No
// assertion in this file depends on a non-zero tax amount.
//
// CONCLUSION: the rejection is real, hits BOTH builders, and needs BOTH keys —
// so each builder sends `customer_update: { address: "auto", name: "auto" }`,
// and (per D) sends it ONLY in the `customerId` branch. Nothing was added on
// speculation, and `billing_address_collection` was NOT touched: Checkout
// already collects what it needs, and forcing it adds friction for no gain.
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE)("automatic_tax on an existing customer (live Stripe, test mode)", () => {
  it("needs customer_update{address,name} on an addressless customer, and only with `customer`", async () => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // The exact shape linkStripeCustomer leaves behind: a customer we linked at
    // purchase time, with no address on file.
    const customer = await stripe.customers.create({
      email: `tax-probe-${Date.now()}@example.com`,
    });
    cleanup.push(() => stripe.customers.del(customer.id));
    expect(customer.address, "probe customer must be addressless").toBeNull();

    const returnUrl = "https://app.test/return?session_id={CHECKOUT_SESSION_ID}";
    const variants = [
      {
        name: "event pass (mode: payment)",
        withCustomer: buildPassCheckoutParams({
          priceId: PASS_PRICE,
          orgId: "org-tax-probe",
          competitionId: "comp-tax-probe",
          competitionName: "Tax Probe Cup",
          returnUrl,
          customerId: customer.id,
        }),
        firstPurchase: buildPassCheckoutParams({
          priceId: PASS_PRICE,
          orgId: "org-tax-probe",
          competitionId: "comp-tax-probe",
          competitionName: "Tax Probe Cup",
          returnUrl,
          customerEmail: `tax-probe-new-${Date.now()}@example.com`,
        }),
      },
      {
        name: "subscription (mode: subscription)",
        withCustomer: buildEmbeddedCheckoutParams({
          priceId: PRO_MONTHLY_PRICE,
          orgId: "org-tax-probe",
          returnUrl,
          trialDays: 0,
          customerId: customer.id,
        }),
        firstPurchase: buildEmbeddedCheckoutParams({
          priceId: PRO_MONTHLY_PRICE,
          orgId: "org-tax-probe",
          returnUrl,
          trialDays: 0,
          customerEmail: `tax-probe-new2-${Date.now()}@example.com`,
        }),
      },
    ];

    for (const v of variants) {
      // (C) what the builder ships for a returning buyer — Stripe accepts it.
      expect(v.withCustomer.customer_update, `${v.name}: customer_update shape`).toEqual({
        address: "auto",
        name: "auto",
      });
      const ok = await stripe.checkout.sessions.create(v.withCustomer);
      expect(ok.status, `${v.name}: session opens with customer_update`).toBe("open");
      cleanup.push(() => stripe.checkout.sessions.expire(ok.id));

      // (A) the historic shape. If Stripe stopped refusing this, the parameter
      // would be speculation and should come back out — so assert the refusal.
      const { customer_update: _drop, ...noUpdate } = v.withCustomer;
      await expect(
        stripe.checkout.sessions.create(noUpdate),
        `${v.name}: no customer_update`,
      ).rejects.toMatchObject({ statusCode: 400, code: "customer_tax_location_invalid" });

      // (B) address alone is not enough while tax_id_collection is on.
      await expect(
        stripe.checkout.sessions.create({ ...noUpdate, customer_update: { address: "auto" } }),
        `${v.name}: customer_update address only`,
      ).rejects.toMatchObject({ statusCode: 400 });

      // (D) the first-purchase branch must NOT carry customer_update, or every
      // brand-new buyer 400s. The builder omits it; prove Stripe accepts that.
      expect("customer_update" in v.firstPurchase, `${v.name}: first purchase`).toBe(false);
      const first = await stripe.checkout.sessions.create(v.firstPurchase);
      expect(first.status, `${v.name}: first-purchase session opens`).toBe("open");
      cleanup.push(() => stripe.checkout.sessions.expire(first.id));
    }

    // (E) the invoice the Event Pass now creates, with a per-competition
    // description so three passes are not three identical rows.
    const passFirst = await stripe.checkout.sessions.retrieve(
      (await stripe.checkout.sessions.create(
        buildPassCheckoutParams({
          priceId: PASS_PRICE,
          orgId: "org-tax-probe",
          competitionId: "comp-tax-probe",
          competitionName: "Probe Cup",
          returnUrl,
          customerId: customer.id,
        }),
      )).id,
    );
    cleanup.push(() => stripe.checkout.sessions.expire(passFirst.id));
    expect(passFirst.invoice_creation?.enabled).toBe(true);
    expect(passFirst.invoice_creation?.invoice_data.description).toBe("Event Pass — Probe Cup");
  }, 120_000);

  // (F) The control that rules out "it is only about WHICH address is taxed".
  it("refuses an existing customer that HAS an address and a name, on tax_id_collection alone", async () => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const customer = await stripe.customers.create({
      email: `addressed-probe-${Date.now()}@example.com`,
      name: "Addressed Buyer",
      address: { line1: "1 Test St", city: "London", postal_code: "SW1A 1AA", country: "GB" },
    });
    cleanup.push(() => stripe.customers.del(customer.id));

    const params = buildPassCheckoutParams({
      priceId: PASS_PRICE,
      orgId: "org-tax-probe",
      competitionId: "comp-tax-probe",
      competitionName: "Addressed Cup",
      returnUrl: "https://app.test/return?session_id={CHECKOUT_SESSION_ID}",
      customerId: customer.id,
    });

    // A saved address does NOT excuse the missing parameter: tax_id_collection
    // rejects every existing customer without customer_update[name]. So this is
    // not a "which address" product question — it is a hard 400 on both
    // builders for every returning buyer.
    const { customer_update: _drop, ...noUpdate } = params;
    await expect(stripe.checkout.sessions.create(noUpdate)).rejects.toMatchObject({
      statusCode: 400,
    });

    const ok = await stripe.checkout.sessions.create(params);
    expect(ok.status).toBe("open");
    cleanup.push(() => stripe.checkout.sessions.expire(ok.id));
  }, 60_000);
});

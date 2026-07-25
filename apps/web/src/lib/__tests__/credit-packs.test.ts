// buildCreditPackCheckoutParams / CREDIT_PACKS — the one-time Checkout for AI
// credit packs (v17 SPEC-2 §5/§6/§8, Phase 3 Task 1). Pure (no Stripe/DB) —
// mirrors billing-checkout.test.ts's coverage of buildPassCheckoutParams:
// mode:"payment", locked currency, no payment_method_types, and the
// `kind: "credit_pack"` / `pack_key` / `credits` metadata contract the webhook
// branches on. `metadata.credits` SNAPSHOTS the grant amount at checkout-
// creation time (P3 T1 review fix) so the webhook grants exactly what was
// sold even if the live CREDIT_PACKS catalog changes or drops the `pack_key`
// before the session is paid — see credit-packs.ts and billing-events.ts.
import { describe, expect, it } from "vitest";
import { buildCreditPackCheckoutParams, CREDIT_PACKS } from "@/lib/credit-packs";
import seed from "@/config/stripe-plans.json";
import { SUPPORTED_CURRENCIES, creditPackOptions, type Currency } from "@/lib/currency";

const base = {
  priceId: "price_pack_10",
  orgId: "org-abc",
  packKey: "credits_10",
  credits: 40,
  returnUrl: "https://app.test/o/x/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
};

describe("CREDIT_PACKS catalog", () => {
  it("has exactly the 4 SKUs from SPEC-2 §6, credits never sent to Stripe", () => {
    expect(Object.keys(CREDIT_PACKS).sort()).toEqual(
      ["credits_10", "credits_100", "credits_25", "credits_50"].sort(),
    );
    expect(CREDIT_PACKS.credits_10).toEqual({ credits: 40, lookupKey: "seazn_credits_10" });
    expect(CREDIT_PACKS.credits_25).toEqual({ credits: 105, lookupKey: "seazn_credits_25" });
    expect(CREDIT_PACKS.credits_50).toEqual({ credits: 220, lookupKey: "seazn_credits_50" });
    expect(CREDIT_PACKS.credits_100).toEqual({ credits: 460, lookupKey: "seazn_credits_100" });
  });

  // Every currency the app can hand these builders must exist in the seed's
  // pack prices, or checkout 400s at runtime — same pin as
  // billing-checkout.test.ts's plan/pass check.
  it("every pack prices every supported currency", () => {
    const missing: string[] = [];
    for (const pack of seed.packs ?? []) {
      const opts = new Set([seed.currency, ...Object.keys(pack.price.currency_options ?? {})]);
      for (const c of SUPPORTED_CURRENCIES) {
        if (!opts.has(c)) missing.push(`${c} missing from ${pack.key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("creditPackOptions (Buy Credits ladder, SPEC-6 §A4)", () => {
  it("renders the ladder from the SAME catalog keys the checkout route validates", () => {
    const opts = creditPackOptions("usd");
    // Same keys as CREDIT_PACKS — the modal sends pack_key, the route checks it.
    expect(opts.map((o) => o.key)).toEqual(Object.keys(CREDIT_PACKS));
    for (const o of opts) expect(o.credits).toBe(CREDIT_PACKS[o.key]!.credits);
  });

  it("derives the bonus % from the smallest pack's rate and flags one best value", () => {
    const opts = creditPackOptions("usd");
    expect(opts[0]!.bonusPct).toBe(0); // the baseline rung has no bonus
    // Bonus rises with size; only the top rung is best value.
    expect(opts.filter((o) => o.bestValue)).toHaveLength(1);
    expect(opts.at(-1)!.bestValue).toBe(true);
    expect(opts.at(-1)!.bonusPct).toBe(Math.max(...opts.map((o) => o.bonusPct)));
  });

  it("prices each rung in the requested currency's set price points", () => {
    for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
      for (const o of creditPackOptions(currency)) {
        const pack = (seed.packs ?? []).find((p) => p.key === o.key)!;
        const expected =
          currency === "usd"
            ? pack.price.unit_amount
            : (pack.price.currency_options as Record<string, number>)[currency];
        expect(o.amountMinor).toBe(expected);
      }
    }
  });
});

describe("buildCreditPackCheckoutParams", () => {
  it("is a one-time embedded payment carrying the credit_pack metadata contract", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.mode).toBe("payment");
    expect(p.return_url).toBe(base.returnUrl);
    expect(p.line_items).toEqual([{ price: "price_pack_10", quantity: 1 }]);
    expect(p.metadata).toEqual({
      kind: "credit_pack",
      org_id: "org-abc",
      pack_key: "credits_10",
      credits: "40",
    });
    expect("subscription_data" in p).toBe(false);
    expect("payment_method_collection" in p).toBe(false);
  });

  it("stamps the PaymentIntent metadata so charge.refunded can recognise a pack charge (P3 T4)", () => {
    // Stripe copies PI metadata onto the Charge; the refund webhook reads it
    // there (the Charge does NOT carry the session metadata). No `credits`
    // snapshot here — a refund claws back from the ledger, never a wire number.
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.payment_intent_data?.metadata).toEqual({
      kind: "credit_pack",
      org_id: "org-abc",
      pack_key: "credits_10",
    });
  });

  it("never sends payment_method_types (stripe skill: dynamic payment methods)", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect("payment_method_types" in p).toBe(false);
  });

  it("tags the session with a stable, non-random integration_identifier", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.integration_identifier).toBe("seazn_credit_pack_wmzqkdxc");
    // Two calls agree — it is a per-integration label, not per-session.
    expect(buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" }).integration_identifier).toBe(
      p.integration_identifier,
    );
  });

  it("disables Stripe Adaptive Pricing and always sends an explicit currency", () => {
    expect(buildCreditPackCheckoutParams(base).adaptive_pricing).toEqual({ enabled: false });
    expect(buildCreditPackCheckoutParams(base).currency).toBe("usd");
    expect(buildCreditPackCheckoutParams({ ...base, currency: "inr" }).currency).toBe("inr");
  });

  it("honours the locked currency for every currency the packs price", () => {
    for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
      expect(buildCreditPackCheckoutParams({ ...base, currency }).currency).toBe(currency);
    }
  });

  it("reuses an existing customer id (with the tax customer_update), else falls back to customer_email", () => {
    const withCust = buildCreditPackCheckoutParams({ ...base, customerId: "cus_9" });
    expect(withCust.customer).toBe("cus_9");
    expect(withCust.customer_update).toEqual({ address: "auto", name: "auto" });
    expect("customer_email" in withCust).toBe(false);

    const withEmail = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withEmail.customer_email).toBe("a@b.com");
    expect("customer" in withEmail).toBe(false);
    expect("customer_update" in withEmail).toBe(false);
  });

  it("creates an invoice named after the credit amount, one per pack size", () => {
    const p10 = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p10.invoice_creation?.enabled).toBe(true);
    expect(p10.invoice_creation?.invoice_data?.description).toBe("AI Credit Pack — 40 credits");
    const p105 = buildCreditPackCheckoutParams({
      ...base,
      packKey: "credits_25",
      credits: 105,
      customerEmail: "a@b.com",
    });
    expect(p105.invoice_creation?.invoice_data?.description).toBe("AI Credit Pack — 105 credits");
  });

  it("brands the checkout like the plan/pass flows", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.branding_settings).toMatchObject({
      background_color: "#150b36",
      button_color: "#a3e635",
      border_style: "rounded",
      display_name: "Seazn Club",
    });
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.tax_id_collection).toEqual({ enabled: true });
  });
});

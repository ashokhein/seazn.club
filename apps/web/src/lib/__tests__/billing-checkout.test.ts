// buildEmbeddedCheckoutParams / buildPassCheckoutParams shape the Stripe
// Embedded Checkout sessions. Pure (no Stripe/DB) — pins the embedded
// ui_mode, the return_url contract, the 14-day no-card trial and the
// pass/currency extensions (v3/07 §3–4) that the checkout routes depend on.
import { describe, expect, it } from "vitest";
import {
  assertCheckoutAllowed,
  buildEmbeddedCheckoutParams,
  buildPassCheckoutParams,
  checkoutTrialDays,
  hasLiveSubscription,
} from "@/lib/billing";
// Stripe's allowed font list for branding_settings.font_family, confirmed
// against the live API's own validation error on 2026-07-20 (a
// StripeInvalidRequestError for an unlisted value enumerates exactly this
// set) — not copied from the human-readable docs table, which omits
// noto_sans_jp. Barlow Condensed (the brand face) is NOT on it, so checkout
// cannot match the site type — `inter` is the closest neutral.
const STRIPE_FONTS = [
  "default", "be_vietnam_pro", "bitter", "chakra_petch", "hahmlet", "inconsolata",
  "inter", "lato", "lora", "m_plus_1_code", "montserrat", "noto_sans_jp",
  "noto_sans", "noto_serif", "nunito", "open_sans", "pridi", "pt_sans",
  "pt_serif", "raleway", "roboto", "roboto_slab", "source_sans_pro",
  "titillium_web", "ubuntu_mono", "zen_maru_gothic",
];
import {
  currencyFromAcceptLanguage,
  formatMinor,
  passPrice,
  proPlusPrice,
  proPrice,
  type Currency,
  SUPPORTED_CURRENCIES,
} from "@/lib/currency";
import { HttpError } from "@/lib/errors";
import { checkoutSchema } from "@/lib/types";
import seed from "@/config/stripe-plans.json";

const base = {
  priceId: "price_123",
  orgId: "org-abc",
  returnUrl: "https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  trialDays: 14,
};

describe("buildEmbeddedCheckoutParams", () => {
  it("uses embedded ui_mode with a return_url and no hosted urls", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.return_url).toBe(base.returnUrl);
    expect("success_url" in p).toBe(false);
    expect("cancel_url" in p).toBe(false);
    expect(p.mode).toBe("subscription");
    expect(p.line_items).toEqual([{ price: "price_123", quantity: 1 }]);
    expect(p.metadata).toMatchObject({ org_id: "org-abc" });
  });

  it("keeps the 14-day no-card trial (cancel if no method by trial end)", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.payment_method_collection).toBe("if_required");
    expect(p.subscription_data?.trial_period_days).toBe(14);
    expect(p.subscription_data?.trial_settings?.end_behavior?.missing_payment_method).toBe("cancel");
  });

  it("trialDays 0: no trial keys, card collection required, metadata kept", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, trialDays: 0, customerEmail: "a@b.com" });
    expect(p.subscription_data && "trial_period_days" in p.subscription_data).toBe(false);
    expect(p.subscription_data && "trial_settings" in p.subscription_data).toBe(false);
    // No trial → payment due at checkout, so the card is always collected.
    expect("payment_method_collection" in p).toBe(false);
    expect(p.subscription_data?.metadata).toEqual({ org_id: "org-abc" });
  });

  it("reuses an existing customer id, else falls back to customer_email", () => {
    const withCust = buildEmbeddedCheckoutParams({ ...base, customerId: "cus_9" });
    expect(withCust.customer).toBe("cus_9");
    expect("customer_email" in withCust).toBe(false);

    const withEmail = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withEmail.customer_email).toBe("a@b.com");
    expect("customer" in withEmail).toBe(false);
  });

  // The actual fix for the quoted-vs-charged mismatch. Adaptive Pricing is ON
  // by default and converts at RENDER time from the customer's IP, so a session
  // created as usd/15900 still displayed £125.00 in the iframe. Verified live
  // 2026-07-20 that `currency` alone does NOT suppress it — only this flag.
  it("disables Stripe Adaptive Pricing on both checkout flows", () => {
    expect(buildEmbeddedCheckoutParams(base).adaptive_pricing).toEqual({ enabled: false });
    expect(
      buildPassCheckoutParams({
        priceId: "price_pass",
        orgId: "org-abc",
        competitionId: "comp-1",
        competitionName: "Riverside Cup",
        returnUrl: base.returnUrl,
        customerEmail: "a@b.com",
      }).adaptive_pricing,
    ).toEqual({ enabled: false });
  });

  // Previously this asserted the opposite for usd — that the key was OMITTED.
  // Explicitness is not what fixes the bug (see the Adaptive Pricing test
  // above); it makes the session state the currency WE picked rather than
  // leaving it implicit.
  it("always sends an explicit currency, usd included", () => {
    expect(buildEmbeddedCheckoutParams({ ...base, currency: "eur" }).currency).toBe("eur");
    expect(buildEmbeddedCheckoutParams({ ...base, currency: "usd" }).currency).toBe("usd");
    // No currency from the caller still means an explicit usd on the wire, not
    // an absent key — an absent key is the bug.
    expect(buildEmbeddedCheckoutParams(base).currency).toBe("usd");
    expect("currency" in buildEmbeddedCheckoutParams(base)).toBe(true);
  });

  // Every currency the app can hand these builders must exist in the price's
  // currency_options, or checkout 400s at runtime. This pins the two lists
  // together so widening one without the other fails here rather than live.
  it("only ever sends a currency the seed prices actually define", () => {
    // Every price the builders can target, not just the first: a currency
    // missing from ANY of them is a 400 on that specific checkout.
    const priceOptionSets = [
      ...seed.plans.flatMap((p) => [p.prices.monthly, p.prices.annual]),
      ...seed.passes.map((p) => p.price),
    ].map((p) => new Set([seed.currency, ...Object.keys(p.currency_options)]));

    const missing: string[] = [];
    for (const c of SUPPORTED_CURRENCIES) {
      priceOptionSets.forEach((opts, i) => {
        if (!opts.has(c)) missing.push(`${c} missing from price #${i}`);
      });
      expect(buildEmbeddedCheckoutParams({ ...base, currency: c }).currency).toBe(c);
    }
    expect(missing).toEqual([]);
  });
});

describe("one trial per org (product gap 2026-07-13)", () => {
  it("first-ever checkout gets the 14-day trial", () => {
    expect(checkoutTrialDays(undefined)).toBe(14);
    expect(checkoutTrialDays({ trial_used_at: null })).toBe(14);
  });

  it("an org that ever trialed gets no second trial — downgrade/upgrade loop closed", () => {
    expect(checkoutTrialDays({ trial_used_at: "2026-01-01T00:00:00Z" })).toBe(0);
  });

  it("checkout is refused while a live Stripe subscription exists", () => {
    for (const status of ["active", "trialing"]) {
      expect(() =>
        assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status }),
      ).toThrowError(/manage/i);
    }
  });

  it("checkout is allowed with no sub row, a canceled sub, or comped Pro", () => {
    expect(() => assertCheckoutAllowed(undefined)).not.toThrow();
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "canceled" }),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: null, status: "active" }),
    ).not.toThrow();
  });
});

describe("buildPassCheckoutParams (v3/07 §3)", () => {
  const pass = {
    priceId: "price_pass",
    orgId: "org-abc",
    competitionId: "comp-1",
    competitionName: "Riverside Cup",
    returnUrl: "https://app.test/o/x/c/y/upgrade?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  };

  it("is a one-time embedded payment carrying org + competition metadata", () => {
    const p = buildPassCheckoutParams({ ...pass, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.mode).toBe("payment");
    expect(p.return_url).toBe(pass.returnUrl);
    expect(p.line_items).toEqual([{ price: "price_pass", quantity: 1 }]);
    expect(p.metadata).toEqual({
      org_id: "org-abc",
      competition_id: "comp-1",
      pass_key: "event_pass",
    });
    // One-time purchase: no trial, no subscription payload.
    expect("subscription_data" in p).toBe(false);
    expect("payment_method_collection" in p).toBe(false);
  });

  it("honours the currency switch like the subscription flow, usd included", () => {
    expect(buildPassCheckoutParams({ ...pass, currency: "inr" }).currency).toBe("inr");
    // Was asserted absent before; an absent currency is what let Stripe's
    // adaptive pricing charge a currency the page never quoted.
    expect(buildPassCheckoutParams({ ...pass, currency: "usd" }).currency).toBe("usd");
    expect(buildPassCheckoutParams(pass).currency).toBe("usd");
  });

  // mode:"payment" produces a PaymentIntent and a Charge but NO Invoice, so a
  // pass buyer had no invoice number, no PDF and no hosted URL — and the
  // billing page, which lists invoices.list({ customer }), showed them nothing
  // at all about $29 they spent. invoice_creation is what puts it there.
  it("creates an invoice named after the competition", () => {
    const p = buildPassCheckoutParams({ ...pass, customerEmail: "a@b.com" });
    expect(p.invoice_creation?.enabled).toBe(true);
    // Per-competition, not a constant: three passes must not be three
    // identical rows on the billing page.
    expect(p.invoice_creation?.invoice_data?.description).toBe("Event Pass — Riverside Cup");
    const other = buildPassCheckoutParams({ ...pass, competitionName: "Autumn Open" });
    expect(other.invoice_creation?.invoice_data?.description).toBe("Event Pass — Autumn Open");
  });
});

// Verified against LIVE Stripe test mode 2026-07-21 — see
// billing-automatic-tax.live.test.ts for the verbatim errors. An existing
// customer with no address + automatic_tax is a 400
// (`customer_tax_location_invalid`); adding only `address: "auto"` is a SECOND
// 400 because tax_id_collection also needs `name`. And `customer_update`
// without `customer` is a third 400 — so it must be conditional.
describe("customer_update on an existing customer (automatic_tax)", () => {
  const pass = {
    priceId: "price_pass",
    orgId: "org-abc",
    competitionId: "comp-1",
    competitionName: "Riverside Cup",
    returnUrl: base.returnUrl,
  };

  it("sends address AND name auto whenever an existing customer is reused", () => {
    for (const p of [
      buildEmbeddedCheckoutParams({ ...base, customerId: "cus_9" }),
      buildPassCheckoutParams({ ...pass, customerId: "cus_9" }),
    ]) {
      expect(p.automatic_tax).toEqual({ enabled: true });
      expect(p.tax_id_collection).toEqual({ enabled: true });
      // Both keys: address alone is still a 400 while tax_id_collection is on.
      expect(p.customer_update).toEqual({ address: "auto", name: "auto" });
    }
  });

  it("omits customer_update entirely on a first purchase (customer_email)", () => {
    for (const p of [
      buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" }),
      buildPassCheckoutParams({ ...pass, customerEmail: "a@b.com" }),
    ]) {
      // "`customer_update` can only be used with `customer`" — sending it
      // unconditionally would 400 every brand-new buyer.
      expect("customer_update" in p).toBe(false);
    }
  });
});

describe("checkout branding", () => {
  it("brands the subscription checkout", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.branding_settings).toMatchObject({
      background_color: "#150b36",
      button_color: "#a3e635",
      border_style: "rounded",
      display_name: "Seazn Club",
    });
  });

  it("brands the Event Pass checkout identically", () => {
    const p = buildPassCheckoutParams({
      priceId: "price_pass", orgId: "org-abc", competitionId: "comp-1",
      competitionName: "Riverside Cup",
      returnUrl: base.returnUrl, customerEmail: "a@b.com",
    });
    expect(p.branding_settings).toEqual(
      buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" }).branding_settings,
    );
  });

  // A typo here is a live 400 at checkout, so pin it against Stripe's list.
  it("uses a font Stripe actually accepts", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(STRIPE_FONTS).toContain(p.branding_settings!.font_family);
  });

  it("leaves the trial params alone", () => {
    const withTrial = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withTrial.payment_method_collection).toBe("if_required");
    expect(withTrial.subscription_data?.trial_period_days).toBe(14);
    const noTrial = buildEmbeddedCheckoutParams({ ...base, trialDays: 0, customerEmail: "a@b.com" });
    expect("payment_method_collection" in noTrial).toBe(false);
    expect(noTrial.subscription_data?.trial_period_days).toBeUndefined();
  });
});

// D13: a pass holder converting to Pro is asked for a card even during the
// trial. Without this the credited subscription can start with nothing to
// charge, and Stripe cancels it at trial end (missing_payment_method: "cancel")
// after the credit has already been handed over.
describe("requireCard on a trial checkout (v3/07 D13)", () => {
  it("drops payment_method_collection so the trial still collects a card", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, requireCard: true, customerEmail: "a@b.com" });
    // The trial itself is untouched — 14 free days, but a card on file.
    expect("payment_method_collection" in p).toBe(false);
    expect(p.subscription_data?.trial_period_days).toBe(14);
    expect(p.subscription_data?.trial_settings).toEqual({
      end_behavior: { missing_payment_method: "cancel" },
    });
  });

  it("changes nothing for a trial checkout that does not require a card", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, requireCard: false, customerEmail: "a@b.com" });
    expect(p.payment_method_collection).toBe("if_required");
    expect(p).toEqual(buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" }));
  });

  it("is a no-op without a trial — trialDays 0 already always collects a card", () => {
    const withFlag = buildEmbeddedCheckoutParams({
      ...base,
      trialDays: 0,
      requireCard: true,
      customerEmail: "a@b.com",
    });
    expect("payment_method_collection" in withFlag).toBe(false);
    expect(withFlag).toEqual(
      buildEmbeddedCheckoutParams({ ...base, trialDays: 0, customerEmail: "a@b.com" }),
    );
  });

  // Credit is delivered as a customer balance transaction precisely BECAUSE
  // this stays on: Checkout rejects `discounts` together with
  // allow_promotion_codes, so a coupon was never available.
  it("leaves allow_promotion_codes on, which is why credit is not a coupon", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, requireCard: true, customerEmail: "a@b.com" });
    expect(p.allow_promotion_codes).toBe(true);
    expect("discounts" in p).toBe(false);
  });
});

describe("currency price points (v3/07 §4)", () => {
  it("reads SET price points from stripe-plans.json", () => {
    expect(proPrice("monthly", "usd")).toBe(1900);
    expect(proPrice("monthly", "eur")).toBe(1800);
    expect(proPrice("monthly", "gbp")).toBe(1500);
    expect(proPrice("monthly", "inr")).toBe(139900);
    expect(proPrice("annual", "usd")).toBe(15900);
    expect(passPrice("usd")).toBe(2900);
    expect(passPrice("gbp")).toBe(2500);
    expect(passPrice("aud")).toBe(4500);
  });

  it("formats whole amounts without decimals", () => {
    expect(formatMinor(1900, "usd")).toBe("$19");
    expect(formatMinor(139900, "inr")).toBe("₹1,399");
    expect(formatMinor(20000 / 12, "usd")).toBe("$16.67");
  });

  it("guesses a currency from Accept-Language, defaulting to usd", () => {
    expect(currencyFromAcceptLanguage("en-GB,en;q=0.9")).toBe("gbp");
    expect(currencyFromAcceptLanguage("en-IN")).toBe("inr");
    expect(currencyFromAcceptLanguage("de-DE,de;q=0.9")).toBe("eur");
    expect(currencyFromAcceptLanguage("en-AU")).toBe("aud");
    expect(currencyFromAcceptLanguage("en-US")).toBe("usd");
    expect(currencyFromAcceptLanguage(null)).toBe("usd");
  });
});

describe("Pro Plus price points", () => {
  it("reads SET price points from stripe-plans.json", () => {
    expect(proPlusPrice("monthly", "usd")).toBe(3900);
    expect(proPlusPrice("monthly", "eur")).toBe(3700);
    expect(proPlusPrice("monthly", "gbp")).toBe(3300);
    expect(proPlusPrice("monthly", "inr")).toBe(299900);
    expect(proPlusPrice("monthly", "aud")).toBe(5900);
    expect(proPlusPrice("annual", "usd")).toBe(32700);
  });

  it("annual gives at least a 30% discount vs 12x monthly, Pro + Pro Plus, every currency", () => {
    for (const price of [proPrice, proPlusPrice]) {
      for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
        const monthly = price("monthly", currency);
        const annual = price("annual", currency);
        // ≥30% off: a year of annual costs no more than 70% of 12 monthly bills.
        expect(annual, `${price.name} annual ${currency}`).toBeLessThanOrEqual(
          monthly * 12 * 0.7,
        );
      }
    }
  });
});

describe("hasLiveSubscription", () => {
  it("is true only for a subscription id in a non-terminal status", () => {
    for (const status of ["trialing", "active", "past_due"]) {
      expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status })).toBe(true);
    }
  });

  // A cancelled subscription keeps its id forever. Branching on the column
  // alone would send a departed customer down the Stripe rails.
  it("is false for a cancelled subscription that still carries its id", () => {
    expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status: "canceled" })).toBe(false);
  });

  it("is false with no subscription id, whatever the status", () => {
    expect(hasLiveSubscription({ stripe_subscription_id: null, status: "past_due" })).toBe(false);
    expect(hasLiveSubscription(undefined)).toBe(false);
  });

  // The predicate must NARROW, not just return true: callers read
  // stripe_subscription_id as a plain string off the back of it. `id: string`
  // below stops compiling if the return type reverts to boolean.
  it("narrows both columns to non-null for callers", () => {
    const sub: { stripe_subscription_id: string | null; status: string | null } = {
      stripe_subscription_id: "sub_1",
      status: "active",
    };
    expect(hasLiveSubscription(sub)).toBe(true);
    if (!hasLiveSubscription(sub)) throw new Error("unreachable");
    const id: string = sub.stripe_subscription_id;
    const status: string = sub.status;
    expect([id, status]).toEqual(["sub_1", "active"]);
  });

  // Pins the `?? ""` fallback: a null status (row written before the column was
  // populated) is not live, and neither is a raw Stripe status — STATUS_MAP has
  // already folded `incomplete` into past_due before anything reaches here, so
  // seeing the raw value means an unmapped write, not a live subscription.
  it("is false for a null status or a raw unmapped Stripe status", () => {
    expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status: null })).toBe(false);
    expect(hasLiveSubscription({ stripe_subscription_id: "sub_1", status: "incomplete" })).toBe(
      false,
    );
  });
});

describe("assertCheckoutAllowed past_due", () => {
  // Dunning still owns a live subscription — a second checkout would mint a
  // SECOND subscription for the same org.
  it("409s an org in dunning", () => {
    // /subscription/i alone also matches the generic active/trialing message, so
    // match on text unique to dunning — and pin the type and status code, or a
    // regression to a plain Error / a 400 would still pass.
    const call = () =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "past_due" });
    expect(call).toThrow(HttpError);
    expect(call).toThrow(/update your card/i);
    let status: unknown;
    try {
      call();
    } catch (e) {
      status = (e as HttpError).status;
    }
    expect(status).toBe(409);
  });

  // STATUS_MAP folds Stripe's `incomplete` into past_due, so this message is
  // the whole recovery path for an org whose first payment never confirmed.
  it("names the recovery path so the block is not a dead end", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "past_due" }),
    ).toThrow(/payment method|retry/i);
  });

  it("still lets a departed customer buy again", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "canceled" }),
    ).not.toThrow();
  });

  // A comped org degraded by the past_due grace has no subscription id and
  // must not be locked out of its FIRST purchase.
  it("never blocks an org with no subscription id", () => {
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: null, status: "past_due" }),
    ).not.toThrow();
  });
});

describe("checkoutSchema plan_key", () => {
  it("accepts pro and pro_plus", () => {
    expect(checkoutSchema.safeParse({ plan_key: "pro", interval: "monthly" }).success).toBe(true);
    expect(checkoutSchema.safeParse({ plan_key: "pro_plus", interval: "annual" }).success).toBe(true);
  });

  it("rejects an unknown plan_key like business", () => {
    expect(checkoutSchema.safeParse({ plan_key: "business", interval: "monthly" }).success).toBe(false);
  });
});

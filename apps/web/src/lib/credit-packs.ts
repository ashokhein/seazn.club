import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import { CHECKOUT_BRANDING, CUSTOMER_UPDATE_FOR_TAX } from "@/lib/billing";
import stripePlans from "@/config/stripe-plans.json";

// AI credit packs — one-time Checkout Sessions that top up an org/group's
// wallet (design/v17-pricing-entitlements/SPEC-2 §5.1/§6/§8, v17 Phase 3
// Task 1). Built per the `stripe:stripe-best-practices` skill: Checkout
// Sessions for a one-time purchase, `payment_method_types` never sent
// (dynamic payment methods), the customer's LOCKED currency (never Stripe
// Adaptive Pricing — the prior $ vs £ bug), and `integration_identifier` so
// this flow shows up distinctly from the plan/pass checkouts in the
// Dashboard.

/** One pack's catalog entry — everything the checkout route needs that is
 *  NOT the live Stripe price id (that is resolved by lookup_key at request
 *  time, see `resolveCreditPackPriceId`, so no `plans`-style table column is
 *  needed to cache it). `credits` is never sent to Stripe; it is the ledger
 *  delta the webhook grants, read from THIS catalog by `key` — never trusted
 *  from Stripe session metadata, which a client cannot alter but which this
 *  still avoids depending on as a source of truth. */
export interface CreditPackCatalogEntry {
  credits: number;
  lookupKey: string;
}

/** Derived from `config/stripe-plans.json`'s `packs` array — the same file
 *  `stripe-sync.ts` seeds Stripe from, so the catalog and the live prices can
 *  never drift out of key-naming step with each other. */
export const CREDIT_PACKS: Record<string, CreditPackCatalogEntry> = Object.fromEntries(
  (stripePlans.packs ?? []).map((p) => [p.key, { credits: p.credits, lookupKey: p.price.lookup_key }]),
);

/** Stable per-integration tag (stripe skill: `integration_identifier`, API
 *  2026-03-25.dahlia+) — NOT per-session/random-per-request. It marks this
 *  checkout surface distinctly from the plan/pass checkouts in the
 *  Dashboard's Checkout comparison view; the 8-letter suffix is the skill's
 *  own convention for keeping integration labels unique. */
const INTEGRATION_IDENTIFIER = "seazn_credit_pack_wmzqkdxc";

/**
 * Params for a one-time credit-pack Checkout Session. Pure (no Stripe/DB
 * calls) — mirrors `buildPassCheckoutParams`'s shape (mode: "payment",
 * embedded_page + return_url, invoice_creation so the purchase shows up on
 * the billing page) with the pack's own metadata contract: `kind:
 * "credit_pack"` disambiguates the webhook branch from the plan/pass ones
 * sharing the same endpoint. `metadata.credits` SNAPSHOTS the grant amount at
 * checkout-creation time (review fix, P3 T1): the webhook fires whenever the
 * buyer finishes paying, which can be well after this session was created, so
 * re-deriving the amount from the LIVE `CREDIT_PACKS` catalog by `pack_key` at
 * that later moment risks a deploy having changed the pack's credit amount or
 * removed the key entirely out from under an open session — either silently
 * over/under-granting, or (removed key) silently granting zero on a paid
 * purchase. Snapshotting here means the webhook grants exactly what was sold,
 * independent of any later catalog edit. `pack_key` is still carried too (for
 * display/audit and as the last-resort fallback the webhook logs against).
 */
export function buildCreditPackCheckoutParams(args: {
  priceId: string;
  orgId: string;
  packKey: string;
  credits: number;
  returnUrl: string;
  customerId?: string;
  customerEmail?: string;
  /** ISO currency — the billing entity's LOCKED currency (SPEC-2 §6): Stripe
   *  forbids mixing currencies on one customer, so this must be whatever
   *  `preferredCurrency` already resolved for the org, never a fresh guess. */
  currency?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    ui_mode: "embedded_page",
    mode: "payment",
    ...(args.customerId
      ? { customer: args.customerId, ...CUSTOMER_UPDATE_FOR_TAX }
      : { customer_email: args.customerEmail }),
    invoice_creation: {
      enabled: true,
      invoice_data: { description: `AI Credit Pack — ${args.credits} credits` },
    },
    currency: args.currency ?? "usd",
    // Same fix as the plan/pass checkouts: Adaptive Pricing re-quotes at
    // RENDER time from the buyer's IP unless explicitly disabled — we quote
    // one currency, we must charge in that currency.
    adaptive_pricing: { enabled: false },
    metadata: {
      kind: "credit_pack",
      org_id: args.orgId,
      pack_key: args.packKey,
      credits: String(args.credits),
    },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    branding_settings: { ...CHECKOUT_BRANDING },
    tax_id_collection: { enabled: true },
    // Digital good — Stripe Tax needs an active registration covering this
    // SKU or it silently collects nothing (stripe skill, tax reference); this
    // inherits the same automatic_tax setup already live for plans/passes.
    automatic_tax: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
}

/**
 * The live Stripe price id for a pack, resolved by `lookup_key` at request
 * time rather than cached in a DB column — there is no `plans` row for a
 * pack to hang a `stripe_price_id_onetime` off of, and `stripe.prices.list`
 * by lookup_key is exactly what Stripe recommends this for. 503s (matching
 * the plan/pass checkout routes' own "Billing is not yet configured" shape)
 * when `stripe:sync` has not yet been run against this Stripe account.
 */
export async function resolveCreditPackPriceId(packKey: string): Promise<string> {
  const pack = CREDIT_PACKS[packKey];
  if (!pack) throw new HttpError(400, `Unknown credit pack: ${packKey}`);
  const found = await getStripe().prices.list({ lookup_keys: [pack.lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  }
  return price.id;
}

/**
 * Open a one-time Checkout Session for a credit pack (v17 Phase 3 Task 1).
 * The API route resolves the caller/org/currency and calls this; kept here
 * (rather than inline in the route) so the Stripe-call shape is one place,
 * matching `buildEmbeddedCheckoutParams`/`buildPassCheckoutParams`'s split
 * between a pure builder and an impure caller.
 *
 * The idempotency key is scoped to a 30-second bucket per (org, pack): enough
 * to dedupe a double-click/retry of the SAME purchase attempt, but short
 * enough that a genuine second pack purchase moments later is never blocked
 * by Stripe replaying the first (completed, one-time) session back.
 */
export async function createCreditPackCheckout(args: {
  orgId: string;
  packKey: string;
  returnUrl: string;
  currency?: string;
  customerId?: string | null;
  customerEmail?: string;
}): Promise<Stripe.Checkout.Session> {
  const pack = CREDIT_PACKS[args.packKey];
  if (!pack) throw new HttpError(400, `Unknown credit pack: ${args.packKey}`);
  const priceId = await resolveCreditPackPriceId(args.packKey);
  const bucket = Math.floor(Date.now() / 30_000);
  return getStripe().checkout.sessions.create(
    buildCreditPackCheckoutParams({
      priceId,
      orgId: args.orgId,
      packKey: args.packKey,
      credits: pack.credits,
      returnUrl: args.returnUrl,
      currency: args.currency,
      customerId: args.customerId ?? undefined,
      customerEmail: args.customerEmail,
    }),
    { idempotencyKey: `credit-pack-checkout-${args.orgId}-${args.packKey}-${bucket}` },
  );
}

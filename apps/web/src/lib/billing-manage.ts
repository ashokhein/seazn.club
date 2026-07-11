import type Stripe from "stripe";

/**
 * Pure core of in-app billing management (v3/11) — param builders and display
 * mappers behind the portal-replacement routes. No Stripe/DB imports so every
 * branch is unit-tested; the routes stay thin.
 */

/** Card-only, off-session SetupIntent: every non-card method is redirect-based
 *  and would leave the site; 3DS runs in Stripe.js's in-page modal. */
export function buildSetupIntentParams(customerId: string): Stripe.SetupIntentCreateParams {
  return {
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
  };
}

export interface IntervalChangeArgs {
  customerId: string;
  subscriptionId: string;
  /** The single subscription item being repriced. */
  itemId: string;
  /** The target interval's price id (plans.stripe_price_id_monthly/annual). */
  priceId: string;
  /** Trialing subs reprice without prorations — nothing has been paid. */
  trialing: boolean;
  /** Unix seconds; the SAME value must be sent to preview and update so the
   *  actual proration equals the previewed one (Stripe's documented contract). */
  prorationDate: number;
}

/** Both directions switch immediately: anchor resets to now and the proration
 *  invoice is issued on the spot, so "charged X today" is literally true;
 *  a downgrade's negative total becomes customer credit balance. */
function prorationShape(a: IntervalChangeArgs) {
  return a.trialing
    ? ({ proration_behavior: "none" } as const)
    : ({
        proration_behavior: "always_invoice",
        billing_cycle_anchor: "now",
        proration_date: a.prorationDate,
      } as const);
}

export function buildIntervalPreviewParams(
  a: IntervalChangeArgs,
): Stripe.InvoiceCreatePreviewParams {
  return {
    customer: a.customerId,
    subscription: a.subscriptionId,
    subscription_details: {
      items: [{ id: a.itemId, price: a.priceId }],
      ...prorationShape(a),
    },
  };
}

export function buildIntervalChangeParams(
  a: IntervalChangeArgs,
): Stripe.SubscriptionUpdateParams & { expand: string[] } {
  return {
    items: [{ id: a.itemId, price: a.priceId }],
    ...prorationShape(a),
    // allow_incomplete keeps the sub updated when the immediate invoice needs
    // SCA; the expanded confirmation_secret drives the in-page confirm.
    ...(a.trialing ? {} : { payment_behavior: "allow_incomplete" as const }),
    expand: ["latest_invoice.confirmation_secret"],
  };
}

export interface IntervalPreviewSummary {
  dueTodayMinor: number;
  creditMinor: number;
  currency: string;
  newPeriodEnd: string | null;
}

/** Collapse a preview invoice into what the confirm dialog shows. */
export function summarizeIntervalPreview(invoice: {
  total: number;
  currency: string;
  lines: { data: Array<{ period?: { end?: number | null } | null } | null> };
}): IntervalPreviewSummary {
  let end: number | null = null;
  for (const line of invoice.lines.data) {
    const e = line?.period?.end;
    if (typeof e === "number" && (end === null || e > end)) end = e;
  }
  return {
    dueTodayMinor: Math.max(invoice.total, 0),
    creditMinor: Math.max(-invoice.total, 0),
    currency: invoice.currency,
    newPeriodEnd: end === null ? null : new Date(end * 1000).toISOString(),
  };
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  createdIso: string;
  totalMinor: number;
  currency: string;
  status: string;
  /** Stripe-hosted invoice page — a document link, not a portal session. */
  hostedUrl: string | null;
  pdfUrl: string | null;
  /** Open = a renewal (or proration) invoice still needing payment. */
  isOpen: boolean;
}

export function invoiceRows(
  invoices: Array<{
    id?: string | null;
    number?: string | null;
    created: number;
    total: number;
    currency: string;
    status?: string | null;
    hosted_invoice_url?: string | null;
    invoice_pdf?: string | null;
  }>,
): InvoiceRow[] {
  return invoices
    .filter((i) => i.status !== "draft")
    .map((i) => ({
      id: i.id ?? "",
      number: i.number ?? null,
      createdIso: new Date(i.created * 1000).toISOString(),
      totalMinor: i.total,
      currency: i.currency,
      status: i.status ?? "unknown",
      hostedUrl: i.hosted_invoice_url ?? null,
      pdfUrl: i.invoice_pdf ?? null,
      isOpen: i.status === "open",
    }))
    .sort((a, b) => (a.createdIso < b.createdIso ? 1 : -1));
}

export interface PaymentMethodRow {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export function paymentMethodRows(
  pms: Array<{
    id: string;
    type?: string | null;
    card?: { brand?: string | null; last4?: string | null; exp_month?: number; exp_year?: number } | null;
  }>,
  defaultId: string | null,
): PaymentMethodRow[] {
  return pms
    .filter((pm) => pm.type === "card" && pm.card)
    .map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand ?? "card",
      last4: pm.card?.last4 ?? "····",
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
      isDefault: pm.id === defaultId,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

export function intervalForPrice(
  priceId: string | null,
  plan: { stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null },
): "monthly" | "annual" | null {
  if (!priceId) return null;
  if (priceId === plan.stripe_price_id_monthly) return "monthly";
  if (priceId === plan.stripe_price_id_annual) return "annual";
  return null;
}

/**
 * Lazy renewal self-heal (webhook-optional, same philosophy as
 * reconcileCheckout): pull the sub live when the mirror looks stale — the
 * period end passed without a webhook, or we're sitting in past_due and the
 * payment may have completed off-site.
 */
export function needsRenewalResync(
  sub: {
    status: string;
    current_period_end: string | Date | null;
    stripe_subscription_id: string | null;
  } | null,
): boolean {
  if (!sub?.stripe_subscription_id) return false;
  if (sub.status === "past_due") return true;
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  if (!sub.current_period_end) return false;
  return new Date(sub.current_period_end).getTime() < Date.now();
}

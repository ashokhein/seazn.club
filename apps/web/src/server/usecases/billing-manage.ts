import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getActiveOrgId, requireOrgRole, requireUser } from "@/lib/auth";
import { syncPaymentMethodFlag, syncSubscription } from "@/lib/billing";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import {
  buildAddressUpdateParams,
  buildApplyPromoParams,
  buildIntervalChangeParams,
  buildIntervalPreviewParams,
  buildSetupIntentParams,
  discountSummary,
  intervalForPrice,
  invoiceRows,
  needsRenewalResync,
  paymentMethodRows,
  summarizeIntervalPreview,
  taxIdRows,
  type BillingAddressInput,
  type BillingInterval,
  type DiscountSummary,
  type IntervalPreview,
  type InvoiceRow,
  type PaymentMethodRow,
  type TaxIdRow,
  type TaxIdType,
} from "@/lib/billing-manage";
export type { BillingInterval, IntervalPreview };
import { proPrice, proPlusPrice, type Currency } from "@/lib/currency";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

/**
 * Server glue for in-app billing management (v3/11) — everything the
 * portal-replacement routes and the billing page share. Pure decisions live in
 * lib/billing-manage; this file owns the Stripe/DB round trips.
 */

interface SubRow {
  plan_key: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  currency: string | null;
}

async function subRow(orgId: string): Promise<SubRow | null> {
  const [sub] = await sql<SubRow[]>`
    select plan_key, status, stripe_customer_id, stripe_subscription_id,
           current_period_end, trial_end, cancel_at_period_end, currency
    from subscriptions where org_id = ${orgId}`;
  return sub ?? null;
}

/** Owner-gated org context shared by every manage route. Session auth comes
 *  FIRST so an unauthenticated caller (e.g. a developer API key — these
 *  routes never read Authorization) gets a clean 401, not a 400 about org
 *  state. */
export async function requireBillingOwner(): Promise<{ orgId: string }> {
  await requireUser();
  const orgId = await getActiveOrgId();
  if (!orgId) throw new HttpError(400, "No active organization");
  await requireOrgRole(orgId, ["owner"]);
  return { orgId };
}

async function requireCustomer(orgId: string): Promise<{ sub: SubRow; customerId: string }> {
  const sub = await subRow(orgId);
  if (!sub?.stripe_customer_id)
    throw new HttpError(400, "No billing account found. Complete checkout first.");
  return { sub, customerId: sub.stripe_customer_id };
}

/** Best-effort person id for org-scoped billing events (owner, else org). */
async function ownerDistinctId(orgId: string): Promise<string> {
  const [row] = await sql<{ created_by: string | null }[]>`
    select created_by from organizations where id = ${orgId}`;
  return row?.created_by ?? `org:${orgId}`;
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

export interface BillingOverview {
  paymentMethods: PaymentMethodRow[];
  invoices: InvoiceRow[];
  /** Positive minor units the customer holds as credit (negative Stripe balance). */
  creditMinor: number;
  currency: string;
  interval: BillingInterval | null;
  hasOpenInvoice: boolean;
  /** Billing details (v3/11 follow-up): drive automatic_tax + invoice header. */
  billingName: string | null;
  billingAddress: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
  taxIds: TaxIdRow[];
  discount: DiscountSummary | null;
}

/**
 * Live Stripe read for the billing page (no local mirror of payment methods
 * or invoices). Also the lazy renewal self-heal: when the DB mirror looks
 * stale — period end passed without a webhook, or past_due that may have been
 * paid off-site — re-sync from the live subscription first. Best-effort:
 * returns null when the org has no Stripe customer or Stripe is unreachable,
 * and the page hides the manage sections.
 */
export async function getBillingOverview(orgId: string): Promise<BillingOverview | null> {
  const sub = await subRow(orgId);
  if (!sub?.stripe_customer_id) return null;
  const stripe = getStripe();

  try {
    if (needsRenewalResync(sub) && sub.stripe_subscription_id) {
      const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      await syncSubscription(orgId, live);
      await invalidateOrgEntitlements(orgId);
    }

    const customerId = sub.stripe_customer_id;
    const [customer, pms, invoices, stripeSub, taxIds] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 10 }),
      stripe.invoices.list({ customer: customerId, limit: 24 }),
      sub.stripe_subscription_id
        ? stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
            // dahlia moved discount.coupon under discount.source.
            expand: ["discounts.source.coupon", "discounts.promotion_code"],
          })
        : Promise.resolve(null),
      stripe.customers.listTaxIds(customerId, { limit: 10 }),
    ]);

    if (customer.deleted) return null;
    const rawDefault = customer.invoice_settings?.default_payment_method;
    const defaultId = typeof rawDefault === "string" ? rawDefault : (rawDefault?.id ?? null);

    const [plan] = await sql<
      { stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null }[]
    >`
      select stripe_price_id_monthly, stripe_price_id_annual
      from plans where key = ${sub.plan_key}`;
    const priceId = stripeSub?.items.data[0]?.price?.id ?? null;
    const rows = invoiceRows(invoices.data);

    return {
      paymentMethods: paymentMethodRows(pms.data, defaultId),
      invoices: rows,
      creditMinor: Math.max(-(customer.balance ?? 0), 0),
      currency: sub.currency ?? "usd",
      interval: plan ? intervalForPrice(priceId, plan) : null,
      hasOpenInvoice: rows.some((r) => r.isOpen),
      billingName: customer.name ?? null,
      billingAddress: customer.address ?? null,
      taxIds: taxIdRows(taxIds.data),
      discount: discountSummary(stripeSub?.discounts),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export async function createCardSetupIntent(orgId: string): Promise<{ client_secret: string }> {
  const { customerId } = await requireCustomer(orgId);
  const si = await getStripe().setupIntents.create(buildSetupIntentParams(customerId));
  if (!si.client_secret) throw new HttpError(500, "Stripe returned no client secret");
  return { client_secret: si.client_secret };
}

/**
 * Make a card the customer default — either the card a just-confirmed
 * SetupIntent saved, or an already-attached card being promoted. Verifies the
 * object belongs to this org's customer before trusting the client-sent id.
 */
export async function setDefaultPaymentMethod(
  orgId: string,
  args: { setupIntentId?: string; paymentMethodId?: string },
): Promise<{ payment_method: string }> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();

  let pmId: string;
  if (args.setupIntentId) {
    const si = await stripe.setupIntents.retrieve(args.setupIntentId);
    if (si.customer !== customerId || si.status !== "succeeded")
      throw new HttpError(400, "Card setup was not completed.");
    pmId = typeof si.payment_method === "string" ? si.payment_method : (si.payment_method?.id ?? "");
  } else if (args.paymentMethodId) {
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer !== customerId)
      throw new HttpError(400, "That card does not belong to this account.");
    pmId = pm.id;
  } else {
    throw new HttpError(400, "Nothing to set as default.");
  }
  if (!pmId) throw new HttpError(400, "No payment method on the setup.");

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });
  // The in-app add-card path the user actually hits during a trial. Stripe now
  // knows; mirror it locally or the trial banner keeps asking for a card the
  // org has just given (report 2026-07-20).
  await syncPaymentMethodFlag(orgId);
  if (args.setupIntentId) {
    await captureServer({
      event: EVENTS.BILLING_CARD_ADDED,
      distinctId: await ownerDistinctId(orgId),
      orgId,
    });
  }
  return { payment_method: pmId };
}

export async function removePaymentMethod(orgId: string, paymentMethodId: string): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  const [pm, customer] = await Promise.all([
    stripe.paymentMethods.retrieve(paymentMethodId),
    stripe.customers.retrieve(customerId),
  ]);
  if (pm.customer !== customerId)
    throw new HttpError(400, "That card does not belong to this account.");
  if (!customer.deleted) {
    const rawDefault = customer.invoice_settings?.default_payment_method;
    const defaultId = typeof rawDefault === "string" ? rawDefault : rawDefault?.id;
    if (defaultId === paymentMethodId)
      throw new HttpError(400, "Make another card the default before removing this one.");
  }
  await stripe.paymentMethods.detach(paymentMethodId);
  // Re-reads Stripe rather than assuming: other cards may remain, in which case
  // the flag stays true.
  await syncPaymentMethodFlag(orgId);
}

// ---------------------------------------------------------------------------
// Interval switch (monthly ↔ annual) + plan switch (Pro ↔ Pro Plus)
// ---------------------------------------------------------------------------

interface IntervalContext {
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
  trialing: boolean;
  currency: string;
  /** The plan key being switched TO — same as the current plan for a plain
   *  interval switch, the target plan for a Pro ↔ Pro Plus change. Drives the
   *  renewalAmountMinor price-point lookup below. */
  planKey: string;
  trialEnd: string | null;
}

/**
 * Shared resolver behind both the interval switch and the Pro ↔ Pro Plus plan
 * switch: looks up the target plan+interval's Stripe price id, retrieves the
 * live subscription's single item, and refuses when that item is already on
 * the requested price. `resolveIntervalChange` below is a thin wrapper that
 * keeps the same plan key (existing endpoints stay untouched).
 */
async function resolvePriceChange(
  orgId: string,
  planKey: string,
  interval: BillingInterval,
  // Interval-only switches keep their existing "already billed X" wording;
  // a genuine plan change (this planKey may differ from the caller's own
  // current plan) says "Already on this plan" instead. Both routes can hit
  // this same refusal (item.price.id === priceId) so the caller picks the
  // message rather than us guessing from planKey === sub.plan_key (which is
  // also true for a plain interval switch, by construction).
  alreadyMessage = "Already on this plan",
): Promise<IntervalContext> {
  const { sub, customerId } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  if (sub.status === "past_due")
    throw new HttpError(400, "Fix the failed payment before changing the plan.");

  const [plan] = await sql<
    { stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null }[]
  >`
    select stripe_price_id_monthly, stripe_price_id_annual
    from plans where key = ${planKey}`;
  const priceId =
    interval === "annual" ? plan?.stripe_price_id_annual : plan?.stripe_price_id_monthly;
  if (!priceId)
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");

  const stripeSub = await getStripe().subscriptions.retrieve(sub.stripe_subscription_id);
  const item = stripeSub.items.data[0];
  if (!item) throw new HttpError(500, "Subscription has no items.");
  if (item.price.id === priceId) throw new HttpError(400, alreadyMessage);

  return {
    customerId,
    subscriptionId: sub.stripe_subscription_id,
    itemId: item.id,
    priceId,
    trialing: stripeSub.status === "trialing",
    currency: sub.currency ?? stripeSub.currency ?? "usd",
    planKey,
    trialEnd: sub.trial_end,
  };
}

async function resolveIntervalChange(
  orgId: string,
  target: BillingInterval,
): Promise<IntervalContext> {
  const { sub } = await requireCustomer(orgId);
  return resolvePriceChange(
    orgId,
    sub.plan_key,
    target,
    `You are already billed ${target === "annual" ? "yearly" : "monthly"}.`,
  );
}

export async function previewIntervalChange(
  orgId: string,
  target: BillingInterval,
): Promise<IntervalPreview> {
  const ctx = await resolveIntervalChange(orgId, target);
  const prorationDate = Math.floor(Date.now() / 1000);
  const renewalAmountMinor =
    ctx.planKey === "pro" ? proPrice(target, ctx.currency as Currency) : null;

  // Trialing: nothing has been paid, nothing is due today — the first charge
  // is the plain new price at trial end. No Stripe call needed.
  if (ctx.trialing) {
    return {
      interval: target,
      trialing: true,
      dueTodayMinor: 0,
      creditMinor: 0,
      currency: ctx.currency,
      newPeriodEnd: ctx.trialEnd,
      renewalAmountMinor,
      prorationDate,
    };
  }

  const invoice = await getStripe().invoices.createPreview(
    buildIntervalPreviewParams({ ...ctx, prorationDate }),
  );
  const s = summarizeIntervalPreview(invoice);
  return {
    interval: target,
    trialing: false,
    dueTodayMinor: s.dueTodayMinor,
    creditMinor: s.creditMinor,
    currency: s.currency,
    newPeriodEnd: s.newPeriodEnd,
    renewalAmountMinor,
    prorationDate,
  };
}

export interface IntervalChangeResult {
  requires_action: boolean;
  client_secret?: string;
}

export async function applyIntervalChange(
  orgId: string,
  target: BillingInterval,
  prorationDate: number,
): Promise<IntervalChangeResult> {
  const ctx = await resolveIntervalChange(orgId, target);
  const stripe = getStripe();

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      ctx.subscriptionId,
      buildIntervalChangeParams({ ...ctx, prorationDate }),
    );
  } catch (err) {
    // A pinned proration_date outside the current period means a renewal (or
    // another change) raced the preview — the numbers we showed are stale.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, "The preview expired — please review the change again.");
    throw err;
  }

  await syncSubscription(orgId, updated);
  await invalidateOrgEntitlements(orgId);
  await captureServer({
    event: EVENTS.BILLING_INTERVAL_CHANGED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: { interval: target },
  });

  const invoice = updated.latest_invoice;
  if (
    invoice &&
    typeof invoice !== "string" &&
    invoice.status === "open" &&
    invoice.confirmation_secret?.client_secret
  ) {
    return { requires_action: true, client_secret: invoice.confirmation_secret.client_secret };
  }
  return { requires_action: false };
}

// ---------------------------------------------------------------------------
// Plan switch (Pro ↔ Pro Plus)
// ---------------------------------------------------------------------------

export type PlanKey = "pro" | "pro_plus";

function renewalAmountFor(planKey: PlanKey, interval: BillingInterval, currency: Currency): number {
  return planKey === "pro" ? proPrice(interval, currency) : proPlusPrice(interval, currency);
}

export async function previewPlanChange(
  orgId: string,
  planKey: PlanKey,
  interval: BillingInterval,
): Promise<IntervalPreview> {
  const ctx = await resolvePriceChange(orgId, planKey, interval);
  const prorationDate = Math.floor(Date.now() / 1000);
  const renewalAmountMinor = renewalAmountFor(planKey, interval, ctx.currency as Currency);

  // Trialing: nothing has been paid, nothing is due today — the first charge
  // is the plain new price at trial end. No Stripe call needed.
  if (ctx.trialing) {
    return {
      interval,
      trialing: true,
      dueTodayMinor: 0,
      creditMinor: 0,
      currency: ctx.currency,
      newPeriodEnd: ctx.trialEnd,
      renewalAmountMinor,
      prorationDate,
    };
  }

  const invoice = await getStripe().invoices.createPreview(
    buildIntervalPreviewParams({ ...ctx, prorationDate }),
  );
  const s = summarizeIntervalPreview(invoice);
  return {
    interval,
    trialing: false,
    dueTodayMinor: s.dueTodayMinor,
    creditMinor: s.creditMinor,
    currency: s.currency,
    newPeriodEnd: s.newPeriodEnd,
    renewalAmountMinor,
    prorationDate,
  };
}

export async function applyPlanChange(
  orgId: string,
  planKey: PlanKey,
  interval: BillingInterval,
  prorationDate: number,
): Promise<IntervalChangeResult> {
  const ctx = await resolvePriceChange(orgId, planKey, interval);
  const stripe = getStripe();

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      ctx.subscriptionId,
      buildIntervalChangeParams({ ...ctx, prorationDate }),
    );
  } catch (err) {
    // A pinned proration_date outside the current period means a renewal (or
    // another change) raced the preview — the numbers we showed are stale.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, "The preview expired — please review the change again.");
    throw err;
  }

  await syncSubscription(orgId, updated);
  // Unlike a plain interval switch, plan_key itself changes here — cached
  // entitlements (limits, feature gates) go stale and must be invalidated.
  await invalidateOrgEntitlements(orgId);
  await captureServer({
    event: EVENTS.BILLING_PLAN_CHANGED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: { plan_key: planKey, interval },
  });

  const invoice = updated.latest_invoice;
  if (
    invoice &&
    typeof invoice !== "string" &&
    invoice.status === "open" &&
    invoice.confirmation_secret?.client_secret
  ) {
    return { requires_action: true, client_secret: invoice.confirmation_secret.client_secret };
  }
  return { requires_action: false };
}

// ---------------------------------------------------------------------------
// Cancel / resume + dunning retry
// ---------------------------------------------------------------------------

export async function setCancelAtPeriodEnd(
  orgId: string,
  cancel: boolean,
  reason?: string,
): Promise<{ cancel_at_period_end: boolean }> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(
      400,
      "This organization has no Stripe subscription — use Downgrade instead.",
    );

  const updated = await getStripe().subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: cancel,
  });
  await syncSubscription(orgId, updated);
  await invalidateOrgEntitlements(orgId);
  await captureServer({
    event: cancel ? EVENTS.SUBSCRIPTION_CANCEL_SCHEDULED : EVENTS.SUBSCRIPTION_RESUMED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
    properties: cancel && reason ? { reason } : undefined,
  });
  return { cancel_at_period_end: updated.cancel_at_period_end };
}

export interface RetryInvoiceResult {
  paid: boolean;
  requires_action?: boolean;
  client_secret?: string;
}

/** Pay the newest open invoice with the (freshly fixed) default card. */
export async function retryOpenInvoice(orgId: string): Promise<RetryInvoiceResult> {
  const { sub, customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  const open = await stripe.invoices.list({ customer: customerId, status: "open", limit: 1 });
  const invoice = open.data[0];
  if (!invoice?.id) throw new HttpError(400, "No open invoice to pay.");

  try {
    await stripe.invoices.pay(invoice.id);
  } catch (err) {
    const code = (err as Stripe.errors.StripeError)?.code;
    if (code === "invoice_payment_intent_requires_action") {
      const fresh = await stripe.invoices.retrieve(invoice.id, {
        expand: ["confirmation_secret"],
      });
      if (fresh.confirmation_secret?.client_secret)
        return {
          paid: false,
          requires_action: true,
          client_secret: fresh.confirmation_secret.client_secret,
        };
    }
    const message = (err as Error)?.message ?? "Payment failed";
    throw new HttpError(402, message);
  }

  if (sub.stripe_subscription_id) {
    const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    await syncSubscription(orgId, live);
    await invalidateOrgEntitlements(orgId);
  }
  return { paid: true };
}

// ---------------------------------------------------------------------------
// Billing details: address, tax IDs, coupons (v3/11 follow-up)
// ---------------------------------------------------------------------------

/** Update the customer's billing name/address — automatic_tax recalculates
 *  from the new location on every invoice from now on (never retroactive). */
export async function updateBillingAddress(
  orgId: string,
  input: BillingAddressInput,
): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  await getStripe().customers.update(customerId, buildAddressUpdateParams(input));
}

export async function addTaxId(
  orgId: string,
  type: TaxIdType,
  value: string,
): Promise<TaxIdRow> {
  const { customerId } = await requireCustomer(orgId);
  try {
    const created = await getStripe().customers.createTaxId(customerId, { type, value });
    return taxIdRows([created])[0];
  } catch (err) {
    // Stripe rejects malformed ids with a helpful message — surface it.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, (err as Error).message);
    throw err;
  }
}

export async function removeTaxId(orgId: string, taxIdId: string): Promise<void> {
  const { customerId } = await requireCustomer(orgId);
  const stripe = getStripe();
  // Only detach ids that actually belong to this org's customer.
  const existing = await stripe.customers.listTaxIds(customerId, { limit: 10 });
  if (!existing.data.some((t) => t.id === taxIdId))
    throw new HttpError(400, "That tax ID does not belong to this account.");
  await stripe.customers.deleteTaxId(customerId, taxIdId);
}

/** Validate a customer-facing promotion code and apply it to the live
 *  subscription — the discount lands on every following invoice. */
export async function applyPromoCode(
  orgId: string,
  code: string,
): Promise<DiscountSummary | null> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  const stripe = getStripe();

  const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  const promo = found.data[0];
  if (!promo) throw new HttpError(400, "That code isn’t valid or has expired.");

  try {
    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      ...buildApplyPromoParams(promo.id),
      expand: ["discounts.source.coupon", "discounts.promotion_code"],
    });
    return discountSummary(updated.discounts);
  } catch (err) {
    // Eligibility rules (first-purchase-only, minimum amount, currency…) are
    // enforced by Stripe at apply time — pass the reason through.
    if ((err as Stripe.errors.StripeError)?.type === "StripeInvalidRequestError")
      throw new HttpError(400, (err as Error).message);
    throw err;
  }
}

export async function removePromoCode(orgId: string): Promise<void> {
  const { sub } = await requireCustomer(orgId);
  if (!sub.stripe_subscription_id)
    throw new HttpError(400, "This organization has no Stripe subscription.");
  await getStripe().subscriptions.deleteDiscount(sub.stripe_subscription_id);
}

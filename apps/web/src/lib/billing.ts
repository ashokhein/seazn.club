import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  invalidateEntitlementsForOrgGroup,
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { requireSubscriptionIdForOrg, subscriptionIdForOrg } from "@/lib/billing-group";
import { LIVE_SUBSCRIPTION_STATUSES, hasLiveSubscription } from "@/lib/subscription-status";
import { grantTrialForRow, recordPassGrant, recordPassRefund, walletIdFor } from "@/lib/credits";
import { PASS_KEYS, isPassKey, type PassKey } from "@/lib/currency";
import stripePlans from "@/config/stripe-plans.json";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { planItem } from "@/lib/subscription-items";
import { creditPassTowardSubscription } from "@/server/usecases/pass-credit";
import { sendPassRungMismatchAlertEmail } from "@/lib/email";

/**
 * Checkout branding (verified against API 2026-06-24.dahlia). Kept in code
 * rather than the Stripe Dashboard so it is versioned and cannot drift between
 * test and live. This is a token set, not CSS — colours, radius, font, logo.
 * `font_family` comes from a fixed list of 26 that does NOT include Barlow
 * Condensed, so checkout cannot match the site's type; `inter` is the closest
 * neutral. Anything finer-grained would mean ui_mode "elements" and owning the
 * payment UI, which is not worth it.
 */
export const CHECKOUT_BRANDING = {
  background_color: "#150b36",
  button_color: "#a3e635",
  border_style: "rounded",
  font_family: "inter",
  display_name: "Seazn Club",
} as const satisfies Stripe.Checkout.SessionCreateParams.BrandingSettings;

/** Thrown when a quantity > 1 is asked of a price that cannot bill it fairly.
 *  Named so callers and tests can match it without string-sniffing. */
export const PRICE_NOT_TIERED = "BILLING_GROUP_PRICE_NOT_TIERED";

/**
 * Refuse to bill a multi-org group against a FLAT (per_unit) price.
 *
 * Stripe prices are immutable, so converting the plan prices from flat to
 * graduated tiers mints NEW prices and archives the old ones — every existing
 * subscription stays on the archived flat one. A per_unit price bills
 * `quantity x base`, so the moment quantity rises above 1 on a legacy price the
 * customer is charged N x the full rate instead of base + half per extra org: a
 * two-org Pro group would pay $38 where it owes $28.
 *
 * Fail closed. Refusing to charge is recoverable — the group is migrated to the
 * tiered price (stripe-sync mints it) and retries. Silently overcharging is
 * not. Quantity 1 is always allowed on any scheme: a single-org group and the
 * one-time Event Pass are legitimate flat, quantity-1 purchases.
 */
export function assertPriceBillsQuantity(args: {
  priceId: string;
  billingScheme: Stripe.Price.BillingScheme | null | undefined;
  quantity: number;
  /** Only for the log line — the operator needs to know WHICH group is stuck. */
  subscriptionId?: string;
}): void {
  if (args.quantity <= 1) return;
  if (args.billingScheme === "tiered") return;
  console.error(
    `[billing] group ${args.subscriptionId ?? "?"} on flat price ${args.priceId}: ` +
      `refusing quantity ${args.quantity} — migrate to the tiered price first`,
  );
  throw new HttpError(
    503,
    "This subscription is on an older price that cannot bill more than one organisation. " +
      `Please contact support (${PRICE_NOT_TIERED}).`,
  );
}

/**
 * Sent with EVERY checkout that reuses an EXISTING Stripe customer, because
 * both builders turn on `automatic_tax` and `tax_id_collection` and a customer
 * we minted at checkout has neither an address nor a business name on file.
 *
 * Probed against LIVE Stripe test mode 2026-07-21 (see
 * billing-automatic-tax.live.test.ts for the verbatim errors) — three distinct
 * 400s, in this order:
 *  - nothing:            `customer_tax_location_invalid` — "Automatic tax
 *                        calculation in Checkout requires a valid address on
 *                        the Customer."
 *  - `address` only:     "Tax ID collection requires updating business name on
 *                        the customer." So BOTH keys are needed, not just one.
 *  - with no `customer`: "`customer_update` can only be used with `customer`"
 *                        — which is why this is spread into the customerId
 *                        branch ONLY and never sent on a first purchase.
 *
 * Rare before linkStripeCustomer ran on the Event Pass path; the COMMON path
 * afterwards, for every org that buys a pass and later upgrades.
 *
 * Exported so `lib/credit-packs.ts` (v17 Phase 3 Task 1) can reuse it verbatim
 * on the credit-pack checkout — same existing-customer tax requirement, no
 * reason to duplicate the probed shape.
 */
export const CUSTOMER_UPDATE_FOR_TAX = {
  customer_update: { address: "auto", name: "auto" },
} as const satisfies Pick<Stripe.Checkout.SessionCreateParams, "customer_update">;

/**
 * Params for an EMBEDDED subscription checkout (rendered in-page via Stripe's
 * Embedded Checkout, not a redirect). Pure — no Stripe/DB — so it's unit-tested.
 * `trialDays` 14 = the no-card trial (`payment_method_collection:
 * "if_required"` + cancel when no card is added by trial end) UNLESS
 * `requireCard` overrides it; 0 = no trial block at all, so Stripe charges at
 * checkout and always collects a card — one trial per org, decided by the
 * caller via checkoutTrialDays().
 * `ui_mode: "embedded"` requires a `return_url` (not success/cancel urls);
 * Stripe redirects there on completion, where the billing page reconciles
 * from the session id.
 */
export function buildEmbeddedCheckoutParams(args: {
  priceId: string;
  orgId: string;
  returnUrl: string;
  trialDays: number;
  customerId?: string;
  customerEmail?: string;
  /** ISO currency picking one of the price's currency_options (v3/07 §4);
   *  defaults to usd, and is ALWAYS sent — see the note on the field below. */
  currency?: string;
  /** Seats to buy: one per org in the BILLING GROUP this checkout pays for
   *  (billing-groups spec — `max(active_org_count, quantity_paid)`, resolved by
   *  billedQuantity). Resolved by the caller, not here, so this stays pure.
   *  Defaults to 1, which is what a brand-new single-org group asks for. */
  quantity?: number;
  /** The resolved price's `billing_scheme`. REQUIRED whenever quantity > 1 —
   *  see assertPriceBillsQuantity. Never read for quantity 1. */
  billingScheme?: Stripe.Price.BillingScheme | null;
  /** The BILLING GROUP (subscriptions.id) this checkout pays for — stamped into
   *  the Stripe metadata as `subscription_id` and the durable answer to "which
   *  row does a webhook for this subscription write?".
   *
   *  `org_id` alone cannot answer that any more: many orgs share one group, and
   *  an org can move between groups (detach), after which its stamp names a
   *  group it no longer bills through — resolving through it would overwrite a
   *  DIFFERENT customer's plan/status/period end. See resolveGroupForStripeSub
   *  in server/usecases/billing-events.ts.
   *
   *  Optional only so the pure-params unit tests can omit it; every real caller
   *  has it (api/billing/checkout gets it from requireBillingOwner, and every
   *  org has had a group since creation). org_id stays alongside it — attribution
   *  and the subscription.created analytics event still key off the buying org. */
  subscriptionId?: string;
  /**
   * Collect a card even when a trial is running (v3/07, D13). Set by the
   * checkout route for an org that holds an Event Pass: that org has already
   * paid us once and is being credited for it, so the "no-card trial" default
   * would let a credited subscription start with nothing to charge at trial end.
   * `trialDays: 0` already forces card collection, so this only bites on a trial.
   */
  requireCard?: boolean;
}): Stripe.Checkout.SessionCreateParams {
  const quantity = Math.max(1, args.quantity ?? 1);
  assertPriceBillsQuantity({
    priceId: args.priceId,
    billingScheme: args.billingScheme,
    quantity,
  });
  // Both the session and the subscription carry it: the session metadata is what
  // the reconcile-on-return path reads, the SUBSCRIPTION metadata is what every
  // later customer.subscription.* webhook carries (Stripe does not copy session
  // metadata onto the subscription).
  const metadata = {
    org_id: args.orgId,
    ...(args.subscriptionId ? { subscription_id: args.subscriptionId } : {}),
  };
  return {
    // stripe-node v22 names the embedded UI mode "embedded_page".
    ui_mode: "embedded_page",
    mode: "subscription",
    ...(args.customerId
      ? { customer: args.customerId, ...CUSTOMER_UPDATE_FOR_TAX }
      : { customer_email: args.customerEmail }),
    // Always sent, usd included, so the session states the currency WE chose
    // via preferredCurrency (subscription → cookie → Accept-Language) instead
    // of leaving it implicit. Safe for every value isSupportedCurrency accepts:
    // usd/eur/gbp/inr/aud all exist in every price's currency_options (verified
    // against live Stripe 2026-07-20). A currency a price LACKS is a 400 at
    // checkout, so those two lists must stay in step — see stripe-plans.json.
    currency: args.currency ?? "usd",
    // This is the one that actually fixes the reported bug. Stripe's Adaptive
    // Pricing is ON by default and converts at RENDER time from the customer's
    // IP: the billing page quoted $13.25/mo while the embedded checkout charged
    // £125.00/yr for a UK visitor. Verified live 2026-07-20 — the session came
    // back currency=usd amount_total=15900 with the currency both omitted AND
    // explicitly usd, so setting `currency` alone does NOT stop it. Only this
    // flag does. We quote in one currency; we must charge in that currency.
    adaptive_pricing: { enabled: false },
    metadata: { ...metadata },
    ...(args.trialDays > 0 && !args.requireCard
      ? { payment_method_collection: "if_required" as const }
      : {}),
    subscription_data: {
      ...(args.trialDays > 0
        ? {
            trial_period_days: args.trialDays,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
          }
        : {}),
      metadata: { ...metadata },
    },
    line_items: [{ price: args.priceId, quantity }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    branding_settings: { ...CHECKOUT_BRANDING },
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
  };
}

/**
 * One trial per organisation (product gap 2026-07-13): the downgrade→upgrade
 * loop must not re-arm the 14-day trial. `trial_used_at` means "this org has
 * had Pro": syncSubscription stamps it on the first sync of ANY subscription,
 * trialing or not. It is not cleared by any normal plan action — the sole
 * exception is the staff `restoreTrial` escape hatch (admin-plan.ts), which
 * refuses to clear it while a live Stripe subscription exists (that sync
 * would just re-stamp it) and is itself audited.
 */
export function checkoutTrialDays(
  sub: { trial_used_at: string | null } | undefined,
): number {
  return sub?.trial_used_at ? 0 : 14;
}

/** Re-exported from their leaf module so historical import sites keep working.
 *  See lib/subscription-status.ts for why they do not live here — that module
 *  is also where the admin plan panel (a client component) imports
 *  hasLiveSubscription from directly, since this file carries `server-only`. */
export { LIVE_SUBSCRIPTION_STATUSES, hasLiveSubscription };

/**
 * A live Stripe subscription means plan changes go through the in-app manage
 * flow — a second checkout would mint a second subscription for the same org.
 * Dunning counts as live: the subscription is still there, it just needs a
 * working card, so the message points at that rather than at a new purchase.
 */
export function assertCheckoutAllowed(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): void {
  if (!hasLiveSubscription(sub)) return;
  if (sub.status === "past_due") {
    throw new HttpError(
      409,
      "This organization's subscription needs a working payment method — update your card or retry the invoice from the billing page instead of starting a new subscription.",
    );
  }
  if (sub.status === "incomplete") {
    // First payment never confirmed (e.g. a 3DS challenge left unfinished). The
    // subscription already exists, so a fresh checkout would mint a second one —
    // point them at completing the pending payment instead.
    throw new HttpError(
      409,
      "This organization has a payment that hasn't finished — complete it, or retry the invoice from the billing page, instead of starting a new subscription.",
    );
  }
  throw new HttpError(
    409,
    "This organization already has a subscription — manage your plan from the billing page instead.",
  );
}

/**
 * How each Event Pass rung is NAMED to the buyer on their Stripe invoice
 * (v17 #294). `Record<PassKey, …>` deliberately: adding a rung to PASS_KEYS
 * without naming it here is a compile error, not a $59 line item silently filed
 * under the $29 product's name. Matches the Stripe product names in
 * stripe-plans.json ("Seazn Club Event Pass" / "… Event Pass L").
 */
const PASS_INVOICE_LABEL: Record<PassKey, string> = {
  event_pass: "Event Pass",
  event_pass_l: "Event Pass L",
};

/**
 * Params for an EMBEDDED one-time Event Pass checkout (v3/07 §3). Same
 * embedded_page/return_url contract as the subscription flow, but
 * mode:"payment" and competition-scoped metadata — the reconcile/webhook path
 * turns a paid session into a competition_passes row. Pure, unit-tested.
 */
export function buildPassCheckoutParams(args: {
  priceId: string;
  orgId: string;
  competitionId: string;
  /** Which Event Pass rung this session buys (v17 #294). REQUIRED — with two
   *  rungs live there is no safe default, and `priceId` and `passKey` must move
   *  together: L's price with M's key charges $59 for M's caps, and the reverse
   *  charges $29 for L's. Stamped into the metadata, which is the ONLY thing
   *  telling the webhook / reconcile paths which rung to record. */
  passKey: PassKey;
  /** Names the invoice line. Required, not optional: an org that buys three
   *  passes would otherwise get three identical rows on its billing page. */
  competitionName: string;
  returnUrl: string;
  customerId?: string;
  customerEmail?: string;
  currency?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    ui_mode: "embedded_page",
    mode: "payment",
    ...(args.customerId
      ? { customer: args.customerId, ...CUSTOMER_UPDATE_FOR_TAX }
      : { customer_email: args.customerEmail }),
    // mode:"payment" produces a PaymentIntent and a Charge but NO Invoice, so a
    // $29 pass used to leave the buyer with no invoice number, no PDF and no
    // hosted URL — and the billing page lists invoices.list({ customer }), so it
    // showed them nothing at all about money they had spent.
    // The rung is named as well as the competition: both rungs land in the same
    // invoices.list() on the billing page, and on PDFs that are otherwise
    // identical apart from the amount, so "Event Pass — Spring Open" on a $59
    // charge is the one place a buyer would reasonably conclude they were
    // overcharged.
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: `${PASS_INVOICE_LABEL[args.passKey]} — ${args.competitionName}`,
      },
    },
    // Both for the same reason as the subscription flow above: state our own
    // currency, and stop Adaptive Pricing re-quoting the pass at render time in
    // whatever currency the buyer's IP suggests.
    currency: args.currency ?? "usd",
    adaptive_pricing: { enabled: false },
    metadata: { org_id: args.orgId, competition_id: args.competitionId, pass_key: args.passKey },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    branding_settings: { ...CHECKOUT_BRANDING },
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
  };
}

/**
 * In-app downgrade to Community for orgs WITHOUT a LIVE Stripe subscription
 * (admin-comped / dev-granted Pro). A Stripe-billed org must cancel through the
 * in-app Cancel (period-end) flow instead, so paid state never desyncs. Idempotent.
 *
 * Liveness, not id presence: a cancelled subscription keeps its id for ever, and
 * compToPro/extendTrial will comp a DEPARTED org back to Pro. Guarding on the id
 * alone would leave staff no way to un-comp what they just comped (`until: null`
 * means for ever) — so `status` is selected and hasLiveSubscription decides.
 */
export async function downgradeToCommunity(orgId: string): Promise<void> {
  // The plan lives on the GROUP now, so this downgrades every org billing
  // through it — which is what a downgrade of a shared subscription means.
  const subscriptionId = await requireSubscriptionIdForOrg(orgId);
  const [sub] = await sql<{ stripe_subscription_id: string | null; status: string | null }[]>`
    select stripe_subscription_id, status from subscriptions where id = ${subscriptionId}`;
  if (hasLiveSubscription(sub)) {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — use “Cancel subscription” on this page.",
    );
  }
  await sql`
    update subscriptions
    set plan_key = 'community', cancel_at_period_end = false,
        -- status only moves when there is NO subscription id at all. A departed
        -- org keeps its dead id, and writing 'active' onto that row would
        -- RESURRECT liveness: this very function would then 400 on the next
        -- call (breaking the idempotence promised above), checkout would 409 and
        -- comp/extendTrial would refuse. So a cancelled status stands. Same
        -- shape as compToPro and extendTrial.
        status = case when stripe_subscription_id is null then 'active' else status end,
        status_changed_at = case when stripe_subscription_id is null
                                      and status is distinct from 'active'
                                 then now() else status_changed_at end
    where id = ${subscriptionId}`;
  // Group-wide: plan_key just moved for every org in the group, and a per-org
  // invalidation would leave the siblings serving Pro for the 300s TTL.
  await invalidateGroupEntitlements(subscriptionId);
}

/**
 * End a billing group that has no one left to manage it (account deletion with
 * no heir).
 *
 * Every billing route gates on `subscriptions.owner_user_id`, so a group whose
 * payer deletes their account and has no successor becomes unmanageable: nobody
 * can cancel it, and Stripe keeps charging the card indefinitely. Leaving that
 * behind is worse than losing the plan, so the subscription is cancelled
 * outright and the group drops to Community.
 *
 * Cancels IMMEDIATELY at Stripe rather than at period end: cancel_at_period_end
 * would still need someone to be able to change their mind, and there is by
 * definition nobody. The Stripe call is best-effort and swallows its own error —
 * the local row must still be truthful (and the deletion must still complete)
 * even if Stripe is unreachable; the subscription.deleted webhook converges the
 * two either way.
 */
export async function cancelBillingGroup(subscriptionId: string): Promise<boolean> {
  const [sub] = await sql<{ stripe_subscription_id: string | null; status: string | null }[]>`
    select stripe_subscription_id, status from subscriptions where id = ${subscriptionId}`;
  if (!sub) return false;
  if (hasLiveSubscription(sub) && sub.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
    } catch (err) {
      // Loud, and NOT followed by a local write. Marking the row `canceled` when
      // Stripe refused is the worst of both: the customer keeps being charged,
      // and the row drops out of every "live subscription" filter — including
      // the reconcile sweep's — so nothing ever retries. Leaving it live is what
      // keeps it visible and retryable.
      console.error("cancelBillingGroup: Stripe cancel failed", subscriptionId, err);
      return false;
    }
  }
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'canceled', cancel_at_period_end = false,
        comped_until = null, updated_at = now(),
        -- Paid slots die with the subscription. A new subscription cannot
        -- inherit the old one's seats, so leaving quantity_paid at 8 would make
        -- billedQuantity quote 8 seats on the re-buy checkout of a group that
        -- now holds three orgs.
        quantity_paid = 1,
        status_changed_at = case when status is distinct from 'canceled'
                                 then now() else status_changed_at end
    where id = ${subscriptionId}`;
  await invalidateGroupEntitlements(subscriptionId);
  return true;
}

/** Map a Stripe subscription status to our subscription status enum. */
const STATUS_MAP: Record<string, string> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  // `incomplete` is kept DISTINCT, not folded into past_due (#206/#223-B): it
  // means the FIRST invoice never succeeded, so the org has paid nothing and
  // must NOT get the 14-day past_due grace (which is for a subscription that WAS
  // active and then a renewal failed). It is still a LIVE status (it owns a real
  // subscription — see LIVE_SUBSCRIPTION_STATUSES), so a second checkout is
  // blocked; the entitlement resolver degrades it to community until it pays.
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  unpaid: "past_due",
  paused: "past_due",
};

/**
 * Label for the primary billing CTA. A trialing Pro org usually has a Stripe
 * customer but no card yet (14-day no-card trial), so the primary ask is "add a
 * card"; once active — or once a trialing org HAS added one — it's ordinary
 * card management, both in-app (v3/11).
 *
 * `hasPaymentMethod` is required rather than defaulted: keying on status alone
 * is exactly the defect this fixes (user report 2026-07-20), and a default
 * would let a new call site reintroduce it silently.
 */
export function billingCtaLabel(status: string, hasPaymentMethod: boolean): string {
  return status === "trialing" && !hasPaymentMethod
    ? "Add a card to keep Pro →"
    : "Manage payment methods";
}

/**
 * THE ONLY WRITER of subscriptions.has_payment_method outside syncSubscription.
 *
 * Every path that can change whether an org has a card on file calls this —
 * in-app add/remove, the Stripe-dashboard payment_method/customer webhooks, and
 * any future staff action. It re-reads the truth from Stripe rather than taking
 * the caller's word, so a new writer is one call, not a new derivation to get
 * wrong. (This branch has repeatedly shipped a fix to one writer and missed its
 * siblings.)
 *
 * Never called from a render path: the banner reads the mirrored column. The
 * ONE render-path exception is getBillingOverview, which already holds a fresh
 * Stripe card list and goes through syncPaymentMethodFlagFromCards below (zero
 * extra Stripe calls).
 *
 * Returns the value written, or null when nothing was written. Null has THREE
 * causes and the caller cannot tell them apart: no subscriptions row, Stripe
 * was unreachable, or the DB write itself failed (swallowed by
 * syncPaymentMethodFlagFromCards, which logs it). A Stripe failure deliberately
 * LEAVES THE MIRROR ALONE: a transient outage must not tell an org that just
 * added a card to add one again.
 */
export async function syncPaymentMethodFlag(orgId: string): Promise<boolean | null> {
  const subscriptionId = await subscriptionIdForOrg(orgId);
  if (!subscriptionId) return null;
  return syncPaymentMethodFlagForSubscription(subscriptionId);
}

/**
 * Same sync, addressed by GROUP. The card lives on the group's Stripe customer,
 * so the webhook path (which resolves a customer id, not an org) writes here
 * directly instead of picking an arbitrary member org to route through.
 */
export async function syncPaymentMethodFlagForSubscription(
  subscriptionId: string,
): Promise<boolean | null> {
  const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
    select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
  if (!sub) return null;
  // No Stripe customer at all means no card, and that is knowable without a
  // round trip.
  if (!sub.stripe_customer_id) return writePaymentMethodFlag(subscriptionId, false);

  try {
    const stripe = getStripe();
    const [customer, pms] = await Promise.all([
      stripe.customers.retrieve(sub.stripe_customer_id),
      stripe.customers.listPaymentMethods(sub.stripe_customer_id, { type: "card", limit: 1 }),
    ]);
    const rawDefault = customer.deleted
      ? null
      : (customer.invoice_settings?.default_payment_method ?? null);
    return writeCardsFlag(subscriptionId, {
      cardCount: pms.data.length,
      hasCustomerDefault: !!rawDefault,
    });
  } catch {
    return null;
  }
}

/**
 * Same write, for a caller that has ALREADY read the customer + card list from
 * Stripe. getBillingOverview does exactly that on every billing-page render, so
 * routing it through here makes an org's own visit to /settings/billing
 * SELF-HEAL the mirror at zero extra Stripe cost — which is what covers every
 * org that existed before V304 shipped with the column defaulted to false (no
 * backfill script, no migration).
 *
 * Swallows its own failure and returns null. This runs on a page render path:
 * a mirror write that fails must degrade to a stale flag, never to a billing
 * page that cannot render. Same "leave the mirror alone" rule as above.
 */
export async function syncPaymentMethodFlagFromCards(
  orgId: string,
  args: { cardCount: number; hasCustomerDefault: boolean },
): Promise<boolean | null> {
  const subscriptionId = await subscriptionIdForOrg(orgId);
  if (!subscriptionId) return null;
  return writeCardsFlag(subscriptionId, args, orgId);
}

/** The card-list → flag write, addressed by group. Shared by both entry points
 *  above so the "attached counts even before default" rule lives in one place. */
async function writeCardsFlag(
  subscriptionId: string,
  args: { cardCount: number; hasCustomerDefault: boolean },
  logOrgId?: string,
): Promise<boolean | null> {
  // An attached card counts even before it is made the customer default: the
  // add-card flow promotes it a moment later, and the banner must not flap.
  const has = args.cardCount > 0 || args.hasCustomerDefault;
  try {
    return await writePaymentMethodFlag(subscriptionId, has);
  } catch (err) {
    const orgId = logOrgId ?? subscriptionId;
    // Swallowed on purpose (render path), but NOT silent: a persistently
    // failing mirror write would otherwise be invisible — every caller just
    // sees the same null it gets for "Stripe was unreachable".
    console.error("syncPaymentMethodFlagFromCards: mirror write failed", orgId, err);
    return null;
  }
}

/**
 * Point an org's subscriptions row at a Stripe customer, keeping the
 * has_payment_method mirror honest.
 *
 * The flag mirrors "cards on customer X", so a checkout that lands the org on a
 * DIFFERENT customer (cancel → re-buy mints a new one) makes the stored value a
 * statement about somebody else's cards. Left alone it inverts the bug this
 * branch fixes: the fresh no-card 14-day trial would inherit `true` and the
 * banner would NEVER ask for a card — a silent trial expiry.
 *
 * Both moves, deliberately:
 *  1. the same UPDATE clears the flag when the id actually changes, so there is
 *     no window in which it describes the old customer, and a Stripe outage
 *     fails SAFE (ask for a card) rather than silently confident;
 *  2. then re-derive from the new customer, because a card-collecting checkout
 *     (trialDays 0) really does leave a card on the new customer and a hard
 *     false would ask an org that just paid to add the card it just added.
 *
 * A same-customer link (the common case: reconcile + webhook both firing)
 * touches nothing, so a renewal never disturbs the mirror or updated_at.
 */
export async function linkStripeCustomer(orgId: string, customerId: string): Promise<void> {
  // The Stripe customer belongs to the GROUP the org bills through, not to the
  // org: two orgs in one group share one customer and one card.
  const subscriptionId = await subscriptionIdForOrg(orgId);
  if (!subscriptionId) return;
  await linkStripeCustomerForGroup(subscriptionId, customerId);
}

/**
 * The same link, addressed by GROUP.
 *
 * org → group is the hop that goes wrong once orgs can move between groups: the
 * checkout that created this customer paid for ONE group, and by the time its
 * webhook arrives the org named in the metadata may bill through another one —
 * at which point writing through the org stamps the payer's customer id onto a
 * different customer's row. V310's partial unique index on stripe_customer_id
 * turns that into a raised error rather than silent corruption, which is a
 * safety net, not a licence to keep resolving through the org.
 */
export async function linkStripeCustomerForGroup(
  subscriptionId: string,
  customerId: string,
): Promise<void> {
  const [before] = await sql<{ stripe_customer_id: string | null }[]>`
    select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
  if (!before) return;
  // The clear is decided in SQL from the row's own value, so it is correct even
  // if another writer moved the id since the select above.
  await sql`
    update subscriptions
    set has_payment_method = case when stripe_customer_id is distinct from ${customerId}
                                  then false else has_payment_method end,
        updated_at = case when stripe_customer_id is distinct from ${customerId}
                          then now() else updated_at end,
        stripe_customer_id = ${customerId}
    where id = ${subscriptionId}`;
  if (before.stripe_customer_id !== customerId)
    await syncPaymentMethodFlagForSubscription(subscriptionId);
}

/**
 * Fix the org's billing currency at its FIRST purchase of ANY kind.
 *
 * Only syncSubscription used to write this, so a pass-only org kept NULL and
 * preferredCurrency (lib/currency-server.ts) fell through to the switcher
 * cookie and then Accept-Language — someone who paid £25 for an Event Pass
 * could be quoted USD for Pro months later. Never-overwrite by precedence:
 * `coalesce(currency, ${new})` keeps the EXISTING value and only fills a null,
 * so once set, only Stripe's own subscription object may restate it (via
 * syncSubscription, whose `coalesce(excluded.currency, …)` prefers the incoming
 * Stripe value — the opposite precedence, and deliberately so).
 *
 * A no-op when the caller has no currency to offer, and (like
 * linkStripeCustomer) when the org has no subscriptions row at all.
 */
export async function pinBillingCurrency(
  orgId: string,
  currency: string | null | undefined,
): Promise<void> {
  if (!currency) return;
  await sql`
    update subscriptions
    set currency   = coalesce(currency, ${currency}),
        updated_at = case when currency is null then now() else updated_at end
    where id = (select subscription_id from organizations where id = ${orgId})`;
}

/** Persist the flag. Private on purpose — go through syncPaymentMethodFlag so
 *  the value always comes from Stripe. */
async function writePaymentMethodFlag(subscriptionId: string, has: boolean): Promise<boolean> {
  await sql`
    update subscriptions
    set has_payment_method = ${has},
        updated_at = case when has_payment_method is distinct from ${has}
                          then now() else updated_at end
    where id = ${subscriptionId}`;
  return has;
}

/**
 * Does this Stripe subscription prove a card is on file? `true` or `null` for
 * "cannot tell from this object" — NEVER false.
 *
 * A subscription object can only ever be POSITIVE evidence. Under the 14-day
 * no-card trial the card the organiser adds lands on the CUSTOMER
 * (invoice_settings.default_payment_method) and the SUBSCRIPTION's
 * default_payment_method stays null, so reading absence as "no card" would
 * clear the flag minutes after the user added one — the reported bug, restored.
 * An expanded customer is no better: it carries a default-payment-method
 * pointer, not the card LIST, so a card that is attached but not yet default
 * looks identical to no card at all. Absence is provable only from a card list
 * (syncPaymentMethodFlag / syncPaymentMethodFlagFromCards), so this returns
 * null and the caller's `coalesce` keeps the mirror.
 */
export function paymentMethodFromStripeSubscription(
  stripeSub: Stripe.Subscription,
): boolean | null {
  if (stripeSub.default_payment_method) return true;
  const customer = stripeSub.customer;
  if (!customer || typeof customer === "string") return null;
  if ("deleted" in customer && customer.deleted) return null;
  return (customer as Stripe.Customer).invoice_settings?.default_payment_method ? true : null;
}

/** Look up our plan_key from a Stripe price ID. */
export async function planKeyForPrice(priceId: string): Promise<string | null> {
  const [row] = await sql<{ key: string }[]>`
    select key from plans
    where stripe_price_id_monthly = ${priceId}
       or stripe_price_id_annual  = ${priceId}`;
  return row?.key ?? null;
}

/**
 * Write an org's BILLING GROUP row from a Stripe Subscription object. Shared by
 * the webhook handler and the reconcile-on-return path so both stay in sync.
 *
 * Formerly an `insert … on conflict (org_id)` upsert. There is nothing to
 * insert any more: every org is created pointing at a group and V310 backfilled
 * the rest, so the row always exists and this is a plain UPDATE by group id. The
 * old ON CONFLICT clause is preserved verbatim as the SET list — in Postgres an
 * UPDATE's right-hand side reads the OLD row, so each `case when <col> is
 * distinct from <new>` keeps exactly the `subscriptions.x` vs `excluded.x`
 * meaning it had.
 */
export async function syncSubscription(
  orgId: string,
  stripeSub: Stripe.Subscription,
): Promise<void> {
  await syncSubscriptionForGroup(await requireSubscriptionIdForOrg(orgId), stripeSub);
}

/**
 * The same write, addressed by GROUP. The webhook path resolves a subscription
 * (group) id directly — from the Stripe metadata stamp, the stored
 * stripe_subscription_id, or the customer — and must NOT round-trip through an
 * org to get back here: an org's `subscription_id` can move (detach), so
 * org → group is exactly the hop that can land on the wrong row.
 */
export async function syncSubscriptionForGroup(
  subscriptionId: string,
  stripeSub: Stripe.Subscription,
): Promise<void> {
  // The PLAN item's price, not `data[0]`'s: an add-on's price maps to no `plans`
  // row, so picking it by position resolved "unknown price" and left the group
  // on whatever plan_key it already had (#329).
  const priceId = planItem(stripeSub)?.price?.id ?? null;
  const knownPlanKey = priceId ? await planKeyForPrice(priceId) : null;
  // Unknown price (grandfathered/migrated in Stripe but not synced into `plans`):
  // keep the org's current plan instead of silently downgrading every affected
  // customer — the stripe:sync drift is a staff problem, not the customer's.
  if (priceId && !knownPlanKey) console.error("syncSubscription: unknown price", priceId);
  // Loud for the same reason the unknown-price branch above is: the fallback
  // below silently lands a possibly-PAYING customer on a status that conveys
  // nothing, and a drift we never see is a drift nobody fixes. Same shape as
  // its sibling, plus the subscription id — unlike a price, a status gives a
  // human nothing to look up without knowing which subscription it came from.
  // `Object.hasOwn`, not a bare index: STATUS_MAP is a Record indexed by a
  // string that comes off the wire, so `STATUS_MAP["constructor"]` (or
  // "toString", "valueOf", …) returns an inherited FUNCTION rather than
  // undefined. That is truthy, so a bare index would skip the error log below
  // AND survive the `??` fallback — writing a Function into subscriptions.status
  // and degrading a customer silently, which is the exact pair of failures both
  // lines exist to prevent. Resolved once, so the log and the value can never
  // disagree about what "known" means.
  const mapped = Object.hasOwn(STATUS_MAP, stripeSub.status)
    ? STATUS_MAP[stripeSub.status]
    : undefined;
  if (!mapped) console.error("syncSubscription: unknown status", stripeSub.status, stripeSub.id);
  // Fallback = the status Stripe invented since this map was written. It must
  // fail SAFE, and `past_due` (the old fallback) failed OPEN: a never-paid
  // status we don't recognise — the likely shape of anything new in the
  // incomplete family — would inherit the 14-day dunning grace in orgPlanKey
  // and convey full Pro, paid for nothing, until a human noticed. `incomplete`
  // conveys no plan AND is still in LIVE_SUBSCRIPTION_STATUSES, so the org is
  // not orphaned and cannot open a second checkout. Anything genuinely paid
  // that lands here corrects itself on the next webhook once the status is
  // mapped; the reverse mistake bills nobody and entitles everybody.
  const status = mapped ?? "incomplete";
  // In Stripe v22, current_period_end lives on each subscription ITEM — and a
  // group with an add-on has more than one, on different cycles. Reading
  // `data[0]` stamped an annual group with a monthly rider's period end,
  // eleven months early, whenever Stripe returned the rider first (#329).
  const periodEnd = planItem(stripeSub)?.current_period_end ?? null;
  // null = this object cannot answer; see paymentMethodFromStripeSubscription.
  const hasPm = paymentMethodFromStripeSubscription(stripeSub);

  await sql.begin(async (tx) => {
    // v17 Task 6 (SPEC-2 §5.4): grant `ai.credits.trial` in the SAME
    // transaction — and off the SAME row lock — as the `trial_used_at`
    // stamp below, so a concurrent sync can never win the stamp before the
    // grant runs (`grantTrialForRow`'s only guard is "the caller already
    // holds the lock and already knows trial_used_at is null"). Read the
    // PRE-update trial_used_at here: a brand-new paid subscription is still
    // 'community' in the DB until the UPDATE below commits, so the grant
    // must use the plan this sync is ABOUT to set (`knownPlanKey`), not
    // whatever is currently stored — reading the stale plan would look up
    // the trial matrix row for the wrong plan and silently grant 0.
    const [current] = await tx<{ plan_key: string; trial_used_at: string | null }[]>`
      select plan_key, trial_used_at from subscriptions where id = ${subscriptionId} for update`;
    if (current && current.trial_used_at === null) {
      const resolvedPlanKey = knownPlanKey ?? current.plan_key ?? "community";
      await grantTrialForRow(tx, subscriptionId, resolvedPlanKey);
    }

    await tx`
      update subscriptions set
        -- Unknown price keeps the group's current plan (never mass-downgrade on drift).
        plan_key               = coalesce(${knownPlanKey}, subscriptions.plan_key, 'community'),
        status                 = ${status},
        stripe_subscription_id = ${stripeSub.id},
        current_period_end     = ${periodEnd ? new Date(periodEnd * 1000).toISOString() : null},
        trial_end              = ${
          stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null
        },
        -- One trial per group — and "trial" means "has had Pro". Any subscription
        -- reaching us counts, including a dashboard-created one that never
        -- carried a trial_end (V277's backfill always assumed this; the code
        -- did not). Never cleared except by the staff Restore trial action.
        -- (The credit grant above may already have stamped this inside this
        -- same transaction — coalesce leaves that stamp untouched either way.)
        trial_used_at          = coalesce(subscriptions.trial_used_at, now()),
        cancel_at_period_end   = ${stripeSub.cancel_at_period_end},
        -- Card on file: only OVERWRITE when this Stripe object could actually
        -- answer. A trialing subscription created by the no-card checkout never
        -- carries its own default_payment_method, so an unexpanded webhook
        -- payload says nothing -- and clearing on it would re-arm the
        -- add-a-payment-method banner for an org that has already added one
        -- (the 2026-07-20 report). The in-app and payment_method webhook
        -- writers keep the mirror honest in that case.
        has_payment_method     = coalesce(${hasPm}::boolean, subscriptions.has_payment_method),
        currency               = coalesce(${stripeSub.currency ?? null}, subscriptions.currency),
        -- Task 7 fold-in: a re-buy (new sub id) clears any stale dispute flags so an
        -- old dispute's late loss can't downgrade the fresh sub; a renewal (same id)
        -- leaves an in-flight dispute's flags intact.
        disputed_at            = case when subscriptions.stripe_subscription_id
                                        is distinct from ${stripeSub.id}
                                      then null else subscriptions.disputed_at end,
        dispute_id             = case when subscriptions.stripe_subscription_id
                                        is distinct from ${stripeSub.id}
                                      then null else subscriptions.dispute_id end,
        -- Grace anchor: stamp only on a real status TRANSITION — a same-status
        -- re-sync (webhook replay, dunning retry) must not move it.
        status_changed_at      = case when subscriptions.status is distinct from ${status}
                                      then now() else subscriptions.status_changed_at end,
        updated_at             = now()
      where id = ${subscriptionId}`;
  });
}

/**
 * Record an Event Pass purchase (v3/07 §3). Idempotent — shared by the webhook
 * and the reconcile-on-return path; invalidates the org's cached entitlements
 * so the pass takes effect immediately.
 *
 * The pass is keyed by competition_id, so only the FIRST payment records. An
 * insert that loses the conflict is either a REPLAY of the same payment
 * (webhook + reconcile racing on one intent — NOT a duplicate) or a genuine
 * SECOND charge (two owners / two tabs). `duplicateIntent` is the losing intent
 * only in the second case, so callers can send it straight back (P0-3b).
 *
 * v17 (SPEC-1 fn3 / SPEC-2 §5, SPEC-6 §A7): a recorded pass also tops the org's
 * wallet up by `PASS_CREDIT_GRANT` one-time credits — the "+25 AI credits" the
 * /pricing card advertises. This is the ONE authoritative grant point: it is the
 * only production insert of a `competition_passes` row, so both the webhook and
 * the reconcile-on-return path funnel through here, and `recordPassGrant`'s
 * per-competition idempotency key makes a replay a guaranteed no-op. The grant
 * is deliberately NOT emitted for a genuine duplicate second charge (that payer
 * is refunded, not credited) — only for the winning insert and for a same-intent
 * replay (which heals a first attempt that died between the pass insert and the
 * grant).
 *
 * v17 #294: the row also records WHICH RUNG was bought. This insert used to omit
 * `pass_key` entirely while V271 declares the column `not null default
 * 'event_pass'`, so an L purchase would have been stored as M — no FK error, no
 * exception, no failing test, just a $59 sale filed as the $29 product and an
 * L-sized competition capped at M's 10 divisions / 128 entrants. The grant
 * itself is flat across rungs by design (L buys a bigger competition, not more
 * credits), so `PASS_CREDIT_GRANT` is deliberately NOT keyed by `passKey`.
 */
export async function recordPassPurchase(args: {
  orgId: string;
  competitionId: string;
  paymentIntent?: string | null;
  /** The rung bought. REQUIRED, and deliberately without a default: an omitted
   *  rung is precisely the bug above, and a default here (or a `?? "event_pass"`
   *  at a call site) only relocates it somewhere quieter. Making callers name the
   *  rung is what lets `tsc` — the CI typecheck gate — enumerate every writer the
   *  day a third rung appears. The column's `not null default 'event_pass'`
   *  (V271) is now doing nothing for this path; it remains only as a schema-level
   *  backstop for rows this function did not write. */
  passKey: PassKey;
}): Promise<{ recorded: boolean; duplicateIntent: string | null }> {
  const { passKey } = args;
  const grantPassCredits = () =>
    walletIdFor(args.orgId).then((walletId) =>
      recordPassGrant(walletId, PASS_CREDIT_GRANT, args.competitionId, args.paymentIntent),
    );

  const [inserted] = await sql<{ competition_id: string }[]>`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, pass_key)
    values (${args.competitionId}, ${args.orgId}, ${args.paymentIntent ?? null}, ${passKey})
    on conflict (competition_id) do nothing
    returning competition_id`;
  if (inserted) {
    await grantPassCredits();
    await invalidateOrgEntitlements(args.orgId);
    return { recorded: true, duplicateIntent: null };
  }
  const [existing] = await sql<{ stripe_payment_intent: string | null }[]>`
    select stripe_payment_intent from competition_passes
    where competition_id = ${args.competitionId}`;
  const dup =
    args.paymentIntent && existing?.stripe_payment_intent !== args.paymentIntent
      ? args.paymentIntent
      : null;
  // A same-intent replay (not a duplicate) re-attempts the grant to heal a first
  // attempt that recorded the pass but died before crediting — the per-
  // competition idempotency key makes it a no-op if the grant already landed.
  if (!dup) await grantPassCredits();
  // ...and busts the cache UNCONDITIONALLY on the way out. The healing path
  // exists precisely because a first attempt can die after the insert — and it
  // can die between the insert and the invalidate too, leaving a warm DENY (or
  // a stale pre-purchase answer) that outlives the pass for the full 300s TTL.
  // A retry that heals the grant but not the cache heals nothing the buyer can
  // see. Idempotent and fail-open by construction (cacheDelPattern swallows its
  // own errors), so running it on the duplicate-charge branch too costs a Redis
  // DEL of a prefix that is usually already empty and can never fail the ACK.
  await invalidateOrgEntitlements(args.orgId);
  return { recorded: false, duplicateIntent: dup };
}

/**
 * Send a duplicate Event Pass payment straight back (registrations' duplicate
 * contract): a second owner / second tab paid for a competition that already
 * has a pass. The Stripe call is deliberately OUTSIDE any transaction and
 * swallows its own failure — a refund hiccup surfaces in the Stripe dashboard
 * but NEVER blocks the webhook / reconcile ACK. A pass charge is a plain
 * platform charge, so no reverse_transfer/application_fee flags. The idempotency
 * key makes a retried refund of the same intent a no-op. (P0-3b)
 */
export async function refundDuplicatePassPayment(intent: string): Promise<void> {
  try {
    await getStripe().refunds.create(
      { payment_intent: intent },
      { idempotencyKey: `pass-dup-refund-${intent}` },
    );
  } catch {
    /* surfaces in Stripe dashboard; never blocks the ACK */
  }
}

/**
 * charge.refunded for an Event Pass (dashboard refunds included): a FULLY
 * refunded pass charge revokes the pass — money back means the comp rejoins
 * the quota (the freeze machinery handles any overage lazily). Partial
 * refunds leave the pass; owner outreach is a support flow, not code.
 *
 * v17 money-safety: the refund also claws back the pass's one-time
 * `PASS_CREDIT_GRANT` (`recordPassRefund`, keyed on the same payment intent the
 * grant used) — money back must mean credits back, or the 25 credits stay
 * farmable after the entitlement is gone. The claw-back runs BEFORE the delete
 * and is idempotent on `pass_refund:${intent}`, so a crash between the two, or a
 * webhook redelivery, self-heals: the retry re-claws (a no-op if it already
 * landed) and re-deletes. It reads the immutable `pass_grant` ledger row, not
 * the `competition_passes` row, so it works even once the pass is deleted. A
 * non-pass refund (no `pass_grant` for this intent) is a harmless no-op.
 */
export async function revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return false;
  await recordPassRefund(intent);
  const [revoked] = await sql<{ org_id: string; competition_id: string }[]>`
    delete from competition_passes where stripe_payment_intent = ${intent}
    returning org_id, competition_id`;
  if (!revoked) return false;
  await invalidateOrgEntitlements(revoked.org_id);
  return true;
}

/**
 * Both reconcile paths return `false` for two very different things: "this
 * session legitimately has nothing to reconcile" and "something blew up".
 * Callers are render paths that must not throw, so the catch stays — but a
 * discarded exception is indistinguishable from an ordinary miss, and that is
 * exactly the failure this branch exists to remove.
 *
 * Not narrowed to a specific expected error on purpose: the try covers a Stripe
 * retrieve (unreachable, revoked key, bogus session id from a hand-edited URL)
 * AND our own DB writes, and only the first family is expected. Narrowing to it
 * would let a DB or cache fault propagate out of a page render and blank the
 * billing page for a customer who has just paid. So everything is still caught,
 * and everything is now VISIBLE — which is what was actually missing. A real
 * fault (2026-07-21: a partially-mocked entitlements module made
 * invalidateEntitlementsForOrgGroup a TypeError) now shows up in the logs
 * instead of looking like a normal negative result.
 */
function logReconcileFailure(
  fn: string,
  orgId: string,
  sessionId: string,
  err: unknown,
): void {
  console.error(`${fn}: failed for org ${orgId} session ${sessionId}`, err);
}

/**
 * Which Event Pass rung a checkout session bought, or `null` if the session is
 * not a pass session at all (v17 #294). The single definition of the pass gate,
 * shared by reconcile-on-return and the webhook so the two can never disagree
 * about what a session means.
 *
 * Two deliberately different answers to two different questions:
 *
 *  - `pass_key` ABSENT → `null`, refuse. Its absence is precisely how a pass
 *    session is told apart from a subscription / credit-pack / size-pack
 *    checkout, none of which ever set it. Widening this to "assume pass" would
 *    make every subscription checkout try to record a competition pass.
 *  - `pass_key` PRESENT but unrecognised → fall back to M. Every real session
 *    has carried `event_pass` since v3/07, so this is a robustness net (metadata
 *    drift, a typo in a future rung), not a migration path: dropping a paid
 *    session on the floor is strictly worse than filing it under the cheaper
 *    rung, which at least leaves the buyer entitled and the money traceable.
 *
 * That fallback is now CHECKED rather than trusted, and the distinction matters
 * because the two policies read as contradictory otherwise (v17 gap #326 review
 * finding 3). `passSessionRungMatchesPrice` runs on the answer this returns, so:
 *
 *   · an unrecognised rung on a session actually built on **M's price** still
 *     mints as M — the robustness net works exactly as described above;
 *   · an unrecognised rung on a session built on **anything else** is refused,
 *     recorded and alerted, because filing a $59 charge under the $29 rung is
 *     not "leaving the buyer entitled", it is quietly under-delivering a product
 *     they paid for. The refusal is recoverable by a human who can see both
 *     numbers; the silent mis-filing was not recoverable at all, because nothing
 *     in the data said it had happened.
 *   · and where the price cannot be compared at all (an unconfigured rung), the
 *     old behaviour survives untouched.
 *
 * So the net is narrowed, not defeated. `pass-checkout-plan-gate.test.ts` drives
 * an unrecognised `pass_key` through the guard both ways so the two halves of
 * this policy cannot drift apart again.
 */
export function passKeyForSession(session: Stripe.Checkout.Session): PassKey | null {
  const raw = session.metadata?.pass_key;
  if (!raw) return null;
  return isPassKey(raw) ? raw : "event_pass";
}

/** Why a paid pass session was refused. Two values because they need two
 *  different sentences in the alert AND two different searches afterwards, and
 *  because the durable row is what a historical sweep will group by. */
export type PassMintRefusalReason = "price_mismatch" | "line_items";

/**
 * Does the price this session was actually built on agree with the rung its
 * metadata names? (v17 gap #326.)
 *
 * `pass_key` is server-written, so this is not a tampering guard — the risk is
 * entirely internal. Both mint paths take the rung from metadata and NOTHING
 * cross-checked it against the price the buyer was charged, so a desync between
 * the checkout route's price lookup and its metadata stamp — a stale
 * `stripe:sync`, a price id edited in the Dashboard, a future third rung wired
 * to the wrong lookup key — produced a customer who paid $29 and held the $59
 * rung (or the reverse) with no error, no failing test, and nothing in the data
 * to find it by afterwards. The W5 review reproduced exactly that by making the
 * checkout route resolve M's price for every rung. The two pre-sale witnesses
 * that catch it (`e2e/event-pass.spec.ts`, `pass-checkout-l.live.test.ts`) are
 * both opt-in and neither runs in CI, and after a sale completes nothing looked
 * again.
 *
 * Returns `false` to REFUSE the mint. Refusing rather than guessing is the
 * posture this codebase already takes for an undetermined pass credit reversal:
 * nothing here can tell which of the two sides is the wrong one, so minting
 * either rung is a coin flip with the customer's money. Every refusal WRITES A
 * ROW (`pass_mint_refusals`, V342) and then alerts, in that order — the row is
 * the record, the email is only the notification, and a bounced email must not
 * be the difference between a traceable incident and none. That row is also the
 * brake: `POST /api/billing/pass-checkout` refuses a repeat purchase for a
 * competition that has an unresolved one, because without it a refused buyer
 * lands back on the upgrade page looking at a live buy button.
 *
 * **Fail-OPEN wherever the comparison cannot be made**, and each case is a
 * deliberate choice, not an oversight:
 *
 *  - **No `plans` row, or a NULL `stripe_price_id_onetime` for the rung.** This
 *    is the NORMAL state of every environment `stripe:sync` has not been run
 *    against, including the test database. It is also not a state a new session
 *    can be created in: the checkout route reads the same column and 503s on a
 *    NULL, so the only sessions that can reach here are older than the wipe.
 *    Checked FIRST, before any Stripe call, so the common unconfigured case
 *    costs one indexed read and nothing else — the same "cheap guard first"
 *    discipline as the maybeAlert* wrappers.
 *  - **The line-item lookup threw.** A transient Stripe failure must not convert
 *    a good purchase into a non-purchase; that blast radius dwarfs the internal
 *    desync being guarded. Logged, because unlike the case above it IS
 *    anomalous — but log-only, because it says nothing about the SESSION.
 *
 * A session reporting no single line item is NOT in that list. It is not
 * transient noise: it means the session does not have the shape
 * `buildPassCheckoutParams` produces, which is the same desync class this guard
 * exists for. It refuses, records and alerts like a mismatch.
 *
 * **LOOKUP KEY BEATS PRICE ID, and this is the interesting part.** The route
 * resolves the price at session-CREATE time and this runs at MINT time, so a
 * `stripe:sync` that re-mints a rung's one-time price in between would refuse
 * every session still in flight — charging those buyers and minting nothing,
 * the precise outcome this guard exists to prevent, triggered by a routine
 * deploy step (and this wave ships a new rung, so that sync WILL run). Stripe's
 * `transfer_lookup_key` moves `seazn_event_pass{,_l}` onto the replacement
 * price, so the lookup key is the rung's DURABLE identity where the price id is
 * only its current one — exactly the reasoning `isOrgAddonItem` already applies
 * to subscription items. So a price whose `lookup_key` still names this rung is
 * accepted even when the id has moved. The id comparison stays as the primary
 * check because the seed could one day ship a rung with no lookup key at all.
 *
 * Line items are read from `session.line_items` when the caller already expanded
 * them (reconcile-on-return does, at no extra cost, and that path re-runs on
 * every render of the bookmarkable `?checkout=success&session_id=` URL), and
 * fetched otherwise — the webhook holds a session off an event payload, which
 * can carry no expansion at all. The fallback is what stops a mint path that
 * forgets to expand from silently skipping the check.
 */
export async function passSessionRungMatchesPrice(
  session: Stripe.Checkout.Session,
  passKey: PassKey,
  orgId: string,
): Promise<boolean> {
  const [row] = await sql<{ price_id: string | null }[]>`
    select stripe_price_id_onetime as price_id from plans where key = ${passKey}`;
  const expectedPriceId = row?.price_id ?? null;
  // Unconfigured, not mismatched — nothing to compare against. See above.
  if (!expectedPriceId) return true;

  let items: Stripe.LineItem[];
  try {
    // limit 2 rather than 1: a pass session is built with exactly one line item
    // (buildPassCheckoutParams), and reading two lets a session that somehow
    // carries more be recognised as not-a-single-rung rather than silently
    // judged on whichever happened to come first.
    items =
      session.line_items?.data ??
      (await getStripe().checkout.sessions.listLineItems(session.id, { limit: 2 })).data;
  } catch (err) {
    console.error(
      `[billing] could not read line items for pass session ${session.id} (org ${orgId}) — ` +
        `minting ${passKey} unverified`,
      err,
    );
    return true;
  }

  const only = items.length === 1 ? items[0] : undefined;
  const actualPriceId = only?.price?.id ?? null;
  if (!only || !actualPriceId) {
    return refusePassMint(session, passKey, orgId, "line_items", expectedPriceId, actualPriceId);
  }
  if (actualPriceId === expectedPriceId) return true;
  // The price id moved but the rung's durable identity did not — a `stripe:sync`
  // replacement, not a desync. See the doc comment.
  if (only.price?.lookup_key && only.price.lookup_key === PASS_LOOKUP_KEYS[passKey]) {
    console.warn(
      `[billing] pass session ${session.id} (org ${orgId}) carries price ${actualPriceId}, ` +
        `not the ${passKey} row's ${expectedPriceId} — accepted on lookup_key ` +
        `${only.price.lookup_key}; the plans row is stale, re-run stripe:sync`,
    );
    return true;
  }
  return refusePassMint(session, passKey, orgId, "price_mismatch", expectedPriceId, actualPriceId);
}

/** The rung's DURABLE Stripe identity, read from the same seed `stripe:sync`
 *  pushes — never restated as a literal here, or a renamed key would silently
 *  turn the lookup-key acceptance above into dead code. Undefined for a rung the
 *  seed ships without one, which simply means the acceptance cannot apply. */
const PASS_LOOKUP_KEYS: Record<PassKey, string | undefined> = Object.fromEntries(
  PASS_KEYS.map((k) => [k, stripePlans.passes?.find((p) => p.key === k)?.price.lookup_key]),
) as Record<PassKey, string | undefined>;

/**
 * Record the refusal, then tell staff, then refuse. Always in that order (v17
 * gap #326 review): the row is the durable evidence and the brake the checkout
 * route reads, so an email that never arrives must not be the difference between
 * a traceable incident and none.
 *
 * Returns `false` unconditionally, so every refusal path in the guard above is
 * one `return refusePassMint(...)` and none of them can forget a step.
 */
async function refusePassMint(
  session: Stripe.Checkout.Session,
  passKey: PassKey,
  orgId: string,
  reason: PassMintRefusalReason,
  expectedPriceId: string,
  actualPriceId: string | null,
): Promise<false> {
  const competitionId = session.metadata?.competition_id ?? null;
  const paymentIntent =
    typeof session.payment_intent === "string" ? session.payment_intent : null;
  console.error(
    `[billing] pass session ${session.id} (org ${orgId}) names rung ${passKey} ` +
      `(price ${expectedPriceId}) but ${
        reason === "line_items"
          ? "did not report exactly one line-item price"
          : `was built on price ${actualPriceId}`
      } — REFUSING to mint; the buyer was charged and holds nothing`,
  );
  const { inserted, writeFailed } = await recordPassMintRefusal({
    // The payment intent is the durable "which charge paid for this" reference;
    // the session id is the fallback for a session that completed without one
    // (never expected for mode:"payment", but still a unique anchor) — the same
    // rule the credit-pack grant applies.
    stripeRef: paymentIntent ?? session.id,
    sessionId: session.id,
    orgId,
    competitionId,
    passKey,
    reason,
    expectedPriceId,
    actualPriceId,
  });
  // THE ROW IS THE DEDUPE, and the alert has to ride it (#326 review round 3).
  // Measured before this: five visits to the return URL produced one row and
  // FIVE emails. That is not a theoretical loop — reconcile-on-return re-runs on
  // every render of a bookmarkable `?checkout=success&session_id=` URL, and the
  // buyer is sitting on a page that has just told them something is wrong, which
  // is an invitation to refresh. Staff would then be paged once per refresh for
  // one incident, which is how an alert channel stops being read.
  //
  // `writeFailed` still alerts, deliberately: that is the documented "degrades to
  // alert-only" path, where the email is the ONLY record of the incident and
  // suppressing it would lose the incident entirely. So the rule is "alert when
  // this call produced new information", which is true for a first insert and for
  // a failure to insert, and false for a conflict.
  if (inserted || writeFailed) {
    await maybeAlertPassRungMismatch({
      sessionId: session.id,
      orgId,
      competitionId: competitionId ?? "(unknown)",
      passKey,
      reason,
      expectedPriceId,
      actualPriceId,
      paymentIntent,
    });
  }
  return false;
}

/**
 * Write the durable refusal row (V342). NEVER THROWS — it sits on the webhook's
 * path, where a throw would turn "one pass was not granted" into a webhook that
 * 500s and retries for ever, and the refusal itself has already been decided by
 * the time this runs. A failure here degrades to "alert only", which is what the
 * guard did before this row existed; it is logged loudly because it also removes
 * the repeat-purchase brake.
 *
 * `on conflict do nothing`: the webhook and reconcile-on-return both reach here
 * for the same charge, and reconcile re-runs on every render of the bookmarkable
 * return URL. First writer wins; `refused_at` should say when it first happened.
 *
 * `returning stripe_ref` is what makes the row the DEDUPE for the staff alert as
 * well as the record — `inserted` is true only for the writer that actually
 * created the row, so N reconciles of one refused charge send exactly one email
 * (#326 review round 3). Two concurrent writers cannot both see it: Postgres
 * returns no row to the loser of `on conflict do nothing`.
 *
 * `writeFailed` is reported separately rather than folded into `!inserted`,
 * because the two mean opposite things to the caller: a conflict says "already
 * known, stay quiet", a failure says "there is now NO durable record, so the
 * email is the only one there will be".
 *
 * A NON-UUID competition id from session metadata is caught here rather than
 * pre-validated: the insert fails its cast, this logs, and the alert still goes
 * out naming the session. Refusing to refuse because the metadata was malformed
 * would be the wrong trade.
 */
async function recordPassMintRefusal(args: {
  stripeRef: string;
  sessionId: string;
  orgId: string;
  competitionId: string | null;
  passKey: PassKey;
  reason: PassMintRefusalReason;
  expectedPriceId: string;
  actualPriceId: string | null;
}): Promise<{ inserted: boolean; writeFailed: boolean }> {
  try {
    if (!args.competitionId) throw new Error("session metadata carried no competition_id");
    const [row] = await sql<{ stripe_ref: string }[]>`
      insert into pass_mint_refusals
        (stripe_ref, session_id, org_id, competition_id, pass_key, reason,
         expected_price_id, actual_price_id)
      values (${args.stripeRef}, ${args.sessionId}, ${args.orgId}, ${args.competitionId},
              ${args.passKey}, ${args.reason}, ${args.expectedPriceId}, ${args.actualPriceId})
      on conflict (stripe_ref) do nothing
      returning stripe_ref`;
    return { inserted: !!row, writeFailed: false };
  } catch (err) {
    console.error(
      `[billing] could not record the pass mint refusal for session ${args.sessionId} ` +
        `(org ${args.orgId}) — the staff alert is now the ONLY record, and the buyer is ` +
        `not blocked from paying again`,
      err,
    );
    return { inserted: false, writeFailed: true };
  }
}

/**
 * Is there an unresolved refused pass payment against this competition? (v17 gap
 * #326 review.) The checkout route's brake: a refusal writes no
 * `competition_passes` row, so its "already has an Event Pass" guard cannot see
 * one, and without this the upgrade page would keep offering the buy button to
 * someone whose money has already been taken — once per attempt, for ever.
 *
 * Reads only UNRESOLVED rows (the V342 partial index): once staff have refunded
 * or granted, the competition is for sale again with no code change.
 */
export async function competitionHasRefusedPassPayment(competitionId: string): Promise<boolean> {
  const [row] = await sql<{ stripe_ref: string }[]>`
    select stripe_ref from pass_mint_refusals
     where competition_id = ${competitionId} and resolved_at is null limit 1`;
  return !!row;
}

/**
 * Best-effort staff alert for a refused mint (v17 gap #326). NEVER THROWS,
 * and gated on STAFF_ALERT_EMAIL before anything else — the same shape as
 * `maybeAlertOrgAllowance` (server/usecases/extra-orgs.ts) and
 * `maybeAlertOrgRepriceFailed` (server/usecases/billing-events.ts), which this
 * deliberately mirrors. Ops-only: `sendPassRungMismatchAlertEmail` carries no
 * i18n, like every other staff alert in lib/email.ts.
 *
 * The own try/catch is not redundant with the caller's: it sits on the webhook's
 * path, where a throw would turn "one pass was not granted" into "this webhook
 * fails and retries for ever", i.e. the telemetry would be a strictly worse
 * outcome than the fault it reports.
 *
 * Exported so the never-throws contract can be tested DIRECTLY rather than
 * through a caller's own catch, which would hide a missing wrapper.
 */
export async function maybeAlertPassRungMismatch(opts: {
  sessionId: string;
  orgId: string;
  competitionId: string;
  passKey: PassKey;
  reason: PassMintRefusalReason;
  expectedPriceId: string;
  actualPriceId: string | null;
  paymentIntent: string | null;
}): Promise<void> {
  try {
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendPassRungMismatchAlertEmail({ to: alertTo, ...opts });
  } catch (err) {
    console.error(
      `[billing] pass rung mismatch alert failed (session ${opts.sessionId})`,
      err,
    );
  }
}

/**
 * Reconcile a completed Event Pass checkout directly from Stripe (same
 * webhook-optional contract as reconcileCheckout). Returns true once the pass
 * is recorded. Best-effort and idempotent; never throws.
 */
export async function reconcilePassCheckout(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    // `line_items` expanded so the mint guard below costs NO extra round trip on
    // the buyer's return render — and this page re-renders on every visit to the
    // bookmarkable `?checkout=success&session_id=` URL, so a second Stripe call
    // here is not paid once per sale, it is paid once per visit. The webhook
    // cannot expand (its session comes off an event payload) and falls back to
    // fetching, which is why the guard accepts both.
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });
    // Only trust a paid, pass-shaped session that belongs to this org.
    const passKey = passKeyForSession(session);
    if (!passKey) return false;
    if (session.metadata?.org_id !== orgId) return false;
    const competitionId = session.metadata.competition_id;
    if (!competitionId || session.payment_status !== "paid") return false;
    // The rung named in the metadata must agree with the price actually
    // charged, or nothing is minted (v17 gap #326). Refusing reports `false`,
    // which this function's contract already means as "nothing to reconcile" —
    // and it is the truth: the upgrade page renders no pass, which is exactly
    // what the buyer holds. The staff alert inside is what makes it recoverable.
    if (!(await passSessionRungMatchesPrice(session, passKey, orgId))) return false;
    const res = await recordPassPurchase({
      orgId,
      competitionId,
      passKey,
      paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : null,
    });
    // Reconcile-on-return can land a second owner's payment; refund it (the
    // pass is already active from the first). The helper swallows its own
    // errors, so a refund hiccup never flips this reconcile to a failure.
    if (res.duplicateIntent) {
      await refundDuplicatePassPayment(res.duplicateIntent);
      return true;
    }
    // The money trace, mirroring reconcileCheckout — and deliberately NOT run
    // for the refunded duplicate above, whose payer is not this org's customer
    // and whose currency is not the one we kept.
    //
    // A REPLAY (same intent, the webhook got here first) still runs both: they
    // are idempotent — linkStripeCustomer touches nothing on a same-customer
    // link, and the currency pin never overwrites — and re-running is what
    // heals a first attempt that died between the insert and these writes.
    //
    // Best-effort, like the refund above: the pass is ALREADY recorded and live
    // once recordPassPurchase returned, so a DB hiccup on either trace write
    // must NOT flip this reconcile to a failure — the return value would then
    // lie about a pass that exists. Logged, not rethrown; the webhook re-runs
    // both idempotently and heals the trace. (issue #210)
    try {
      if (session.customer) {
        // Not a bare UPDATE: a re-buy lands on a NEW customer and the
        // has_payment_method mirror describes the OLD one. See linkStripeCustomer.
        await linkStripeCustomer(orgId, session.customer as string);
      }
      await pinBillingCurrency(orgId, session.currency);
    } catch (err) {
      logReconcileFailure("reconcilePassCheckout", orgId, sessionId, err);
    }
    return true;
  } catch (err) {
    logReconcileFailure("reconcilePassCheckout", orgId, sessionId, err);
    return false;
  }
}

/**
 * Reconcile a completed checkout directly from Stripe, so a paid org's plan
 * updates even if the webhook is delayed, missed, or (as happened) the endpoint
 * was deleted. Best-effort and idempotent; never throws.
 */
export async function reconcileCheckout(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "subscription.items.data.price"],
    });

    // Only trust a session that belongs to this org.
    if (session.metadata?.org_id && session.metadata.org_id !== orgId) {
      return false;
    }

    if (session.customer) {
      // Not a bare UPDATE: a re-buy lands on a NEW customer and the
      // has_payment_method mirror describes the OLD one. See linkStripeCustomer.
      await linkStripeCustomer(orgId, session.customer as string);
    }

    const subObj = session.subscription;
    if (subObj && typeof subObj !== "string") {
      await syncSubscription(orgId, subObj);
      // The plan just changed on the GROUP; drop the cached entitlements of
      // every org billing through it so a missed-webhook reconcile takes effect
      // immediately instead of waiting out the TTL, and no sibling org keeps
      // serving the old plan.
      await invalidateEntitlementsForOrgGroup(orgId);
      // Pass-to-Pro credit (v3/07 D12; grant timing moved 2026-07-26 — see
      // docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1).
      // This is the reconcile-on-return arm of "learn a subscription started";
      // the other is billing-events.ts handleSubscriptionChanged, for when the
      // webhook DOES arrive. Run after the entitlement drop rather than before:
      // entitlements are what the page renders next, so they take priority, and
      // the credit is orthogonal to them (a balance transaction, not a plan
      // flag) — ordering between the two has no observable effect either way.
      // `orgId` is already this function's own parameter — no metadata lookup
      // needed, unlike the webhook arm.
      //
      // creditPassTowardSubscription is documented never to throw, but this
      // whole function is one big try/catch that reports ANY throw as a
      // failed reconcile (`return false`) — and the plan sync above already
      // committed, so that would be a lie: the sync succeeded and only the
      // credit attempt, a wholly separate concern, did not. Caught locally so
      // a broken promise from that seam degrades to a missed credit (still
      // recoverable — the next webhook or return-reconcile tries again, and
      // groupAlreadyRedeemed makes retrying free) rather than reconcileCheckout
      // reporting the sync itself as failed.
      try {
        await creditPassTowardSubscription(orgId);
      } catch (err) {
        logReconcileFailure("reconcileCheckout (pass credit)", orgId, sessionId, err);
      }
      return true;
    }
    return false;
  } catch (err) {
    logReconcileFailure("reconcileCheckout", orgId, sessionId, err);
    return false;
  }
}

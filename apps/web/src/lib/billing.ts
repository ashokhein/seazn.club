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
 */
const CUSTOMER_UPDATE_FOR_TAX = {
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
  throw new HttpError(
    409,
    "This organization already has a subscription — manage your plan from the billing page instead.",
  );
}

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
    invoice_creation: {
      enabled: true,
      invoice_data: { description: `Event Pass — ${args.competitionName}` },
    },
    // Both for the same reason as the subscription flow above: state our own
    // currency, and stop Adaptive Pricing re-quoting the pass at render time in
    // whatever currency the buyer's IP suggests.
    currency: args.currency ?? "usd",
    adaptive_pricing: { enabled: false },
    metadata: { org_id: args.orgId, competition_id: args.competitionId, pass_key: "event_pass" },
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
  incomplete: "past_due",
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
  const priceId = stripeSub.items.data[0]?.price?.id ?? null;
  const knownPlanKey = priceId ? await planKeyForPrice(priceId) : null;
  // Unknown price (grandfathered/migrated in Stripe but not synced into `plans`):
  // keep the org's current plan instead of silently downgrading every affected
  // customer — the stripe:sync drift is a staff problem, not the customer's.
  if (priceId && !knownPlanKey) console.error("syncSubscription: unknown price", priceId);
  const status = STATUS_MAP[stripeSub.status] ?? "past_due";
  // In Stripe v22, current_period_end lives on each subscription item.
  const periodEnd = stripeSub.items.data[0]?.current_period_end ?? null;
  // null = this object cannot answer; see paymentMethodFromStripeSubscription.
  const hasPm = paymentMethodFromStripeSubscription(stripeSub);

  await sql`
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
 */
export async function recordPassPurchase(args: {
  orgId: string;
  competitionId: string;
  paymentIntent?: string | null;
}): Promise<{ recorded: boolean; duplicateIntent: string | null }> {
  const [inserted] = await sql<{ competition_id: string }[]>`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent)
    values (${args.competitionId}, ${args.orgId}, ${args.paymentIntent ?? null})
    on conflict (competition_id) do nothing
    returning competition_id`;
  if (inserted) {
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
 */
export async function revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return false;
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
 * Reconcile a completed Event Pass checkout directly from Stripe (same
 * webhook-optional contract as reconcileCheckout). Returns true once the pass
 * is recorded. Best-effort and idempotent; never throws.
 */
export async function reconcilePassCheckout(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    // Only trust a paid, pass-shaped session that belongs to this org.
    if (session.metadata?.pass_key !== "event_pass") return false;
    if (session.metadata.org_id !== orgId) return false;
    const competitionId = session.metadata.competition_id;
    if (!competitionId || session.payment_status !== "paid") return false;
    const res = await recordPassPurchase({
      orgId,
      competitionId,
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
      return true;
    }
    return false;
  } catch (err) {
    logReconcileFailure("reconcileCheckout", orgId, sessionId, err);
    return false;
  }
}

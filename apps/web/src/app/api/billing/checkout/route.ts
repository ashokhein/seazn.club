import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { checkoutSchema } from "@/lib/types";
import {
  assertCheckoutAllowed,
  buildEmbeddedCheckoutParams,
  checkoutTrialDays,
} from "@/lib/billing";
import { billedQuantity } from "@/lib/billing-group";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { preferredCurrency } from "@/lib/currency-server";
import { routes } from "@/lib/routes";

/** POST /api/billing/checkout — start an EMBEDDED Stripe Checkout session and
 *  return its client_secret; the billing page mounts <EmbeddedCheckout> with it
 *  (in-page, no redirect until completion). */
export async function POST(req: Request) {
  return handler(async () => {
    // The GROUP's payer, not this org's owner. This checkout reuses the group's
    // Stripe customer (with the payer's saved cards on it), burns the group's
    // single trial, and lands a plan that every sibling org resolves through —
    // so a member org's owner starting it would be spending someone else's
    // money. Same gate as every other billing mutation.
    const user = await requireUser();
    const { orgId, subscriptionId } = await requireBillingOwner();
    const { plan_key, interval } = checkoutSchema.parse(await req.json());

    // Resolve Stripe price ID from the plans table
    const priceCol =
      interval === "annual" ? "stripe_price_id_annual" : "stripe_price_id_monthly";
    const [plan] = await sql<{ price_id: string | null }[]>`
      select ${sql(priceCol)} as price_id from plans where key = ${plan_key}`;
    if (!plan?.price_id)
      throw new HttpError(
        503,
        "Billing is not yet configured. Please contact support.",
      );

    // Reuse existing Stripe customer if we already have one
    const [[sub], [org], quantity] = await Promise.all([
      sql<{
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        status: string | null;
        trial_used_at: string | null;
      }[]>`
        select stripe_customer_id, stripe_subscription_id, status, trial_used_at
        from subscriptions where id = ${subscriptionId}`,
      sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`,
      // One seat per org already in the group (never fewer than what has been
      // paid for), so a group of three checking out buys three seats up front.
      billedQuantity(subscriptionId),
    ]);
    // A live Stripe sub changes plan in-app, never via a second checkout.
    assertCheckoutAllowed(sub);

    // Only a multi-seat checkout needs to know how the price bills, so the
    // single-org case (the overwhelming majority) pays no extra Stripe round
    // trip. A flat legacy price would bill quantity x full rate — see
    // assertPriceBillsQuantity, which refuses rather than overcharge.
    const billingScheme =
      quantity > 1 ? (await getStripe().prices.retrieve(plan.price_id)).billing_scheme : null;

    const session = await getStripe().checkout.sessions.create(
      buildEmbeddedCheckoutParams({
        priceId: plan.price_id,
        orgId,
        // The durable webhook key: this subscription pays for THIS group, and
        // stays true even if `orgId` later moves to another one.
        subscriptionId,
        returnUrl: `${baseUrl(req)}${routes.billing(org.slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        // One trial per org — a re-subscribing org pays from day one.
        trialDays: checkoutTrialDays(sub),
        currency: await preferredCurrency(orgId, req),
        customerId: sub?.stripe_customer_id ?? undefined,
        customerEmail: user.email,
        quantity,
        billingScheme,
      }),
    );

    return { client_secret: session.client_secret };
  });
}

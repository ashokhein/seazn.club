import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
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
import { preferredCurrency } from "@/lib/currency-server";
import { routes } from "@/lib/routes";

/** POST /api/billing/checkout — start an EMBEDDED Stripe Checkout session and
 *  return its client_secret; the billing page mounts <EmbeddedCheckout> with it
 *  (in-page, no redirect until completion). */
export async function POST(req: Request) {
  return handler(async () => {
    const orgId = await getActiveOrgId();
    if (!orgId) throw new HttpError(400, "No active organization");

    // Only owners may manage billing
    const { user } = await requireOrgRole(orgId, ["owner"]);
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
    const [[sub], [org]] = await Promise.all([
      sql<{
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        status: string | null;
        trial_used_at: string | null;
      }[]>`
        select stripe_customer_id, stripe_subscription_id, status, trial_used_at
        from subscriptions where org_id = ${orgId}`,
      sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`,
    ]);
    // A live Stripe sub changes plan in-app, never via a second checkout.
    assertCheckoutAllowed(sub);

    const session = await getStripe().checkout.sessions.create(
      buildEmbeddedCheckoutParams({
        priceId: plan.price_id,
        orgId,
        returnUrl: `${baseUrl(req)}${routes.billing(org.slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        // One trial per org — a re-subscribing org pays from day one.
        trialDays: checkoutTrialDays(sub),
        currency: await preferredCurrency(orgId, req),
        customerId: sub?.stripe_customer_id ?? undefined,
        customerEmail: user.email,
      }),
    );

    return { client_secret: session.client_secret };
  });
}

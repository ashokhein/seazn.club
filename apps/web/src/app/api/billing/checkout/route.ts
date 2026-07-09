import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { checkoutSchema } from "@/lib/types";
import { buildEmbeddedCheckoutParams } from "@/lib/billing";

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
    const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where org_id = ${orgId}`;

    const session = await getStripe().checkout.sessions.create(
      buildEmbeddedCheckoutParams({
        priceId: plan.price_id,
        orgId,
        returnUrl: `${baseUrl(req)}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        customerId: sub?.stripe_customer_id ?? undefined,
        customerEmail: user.email,
      }),
    );

    return { client_secret: session.client_secret };
  });
}

import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { checkoutSchema } from "@/lib/types";

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
    const existingCustomerId = sub?.stripe_customer_id ?? undefined;

    const stripe = getStripe();
    const base = baseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: user.email }),
      metadata: { org_id: orgId },
      // Honour the "no card required" trial: don't ask for a payment method up
      // front. If none is added by the time the trial ends, cancel rather than
      // silently attempting to bill a card we never collected.
      payment_method_collection: "if_required",
      subscription_data: {
        trial_period_days: 14,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
        metadata: { org_id: orgId },
      },
      line_items: [{ price: plan.price_id, quantity: 1 }],
      success_url: `${base}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/settings/billing`,
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
    });

    return { url: session.url };
  });
}

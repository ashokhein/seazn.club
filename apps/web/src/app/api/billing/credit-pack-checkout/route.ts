import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { CREDIT_PACKS, createCreditPackCheckout } from "@/lib/credit-packs";
import { preferredCurrency } from "@/lib/currency-server";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { routes } from "@/lib/routes";

const schema = z
  .object({
    pack_key: z.string().refine((k) => k in CREDIT_PACKS, "Unknown credit pack"),
  })
  .strict();

/**
 * POST /api/billing/credit-pack-checkout — start an EMBEDDED one-time
 * Checkout Session to buy an AI credit pack (v17 SPEC-2 §5/§6/§8) and return
 * its client_secret. Same embedded_page + reconcile-on-return-by-webhook
 * contract as the plan/pass checkouts.
 *
 * `requireBillingOwner` (not the plain org-owner gate `pass-checkout` uses):
 * the wallet is the GROUP's shared pool, charged on the group's one payer
 * (SPEC-2 §11.3/§11.4) — unlike an Event Pass, which is genuinely org-scoped
 * and any org owner may buy for their own competition.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { orgId, subscriptionId } = await requireBillingOwner();
    const { pack_key } = schema.parse(await req.json());

    const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${orgId}`;
    if (!org) throw new HttpError(404, "organization not found");

    const returnUrl =
      `${baseUrl(req)}${routes.billing(org.slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    const session = await createCreditPackCheckout({
      orgId,
      packKey: pack_key,
      returnUrl,
      // The billing entity's LOCKED currency (SPEC-2 §6) — an existing
      // subscription's currency wins here, exactly as it does for the plan
      // and pass checkouts, so a pack purchase is never quoted in a currency
      // Stripe would then reject as a currency_options mismatch.
      currency: await preferredCurrency(orgId, req),
      customerId: sub?.stripe_customer_id,
      customerEmail: user.email,
    });

    return { client_secret: session.client_secret };
  });
}

import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { routes } from "@/lib/routes";

/** Safety hatch only (v3/11): billing management moved in-app and no UI links
 *  here anymore. Kept for one release behind BILLING_PORTAL_FALLBACK=1 in case
 *  an edge case needs the Stripe-hosted portal, then this route dies. */
export async function POST(req: Request) {
  return handler(async () => {
    if (process.env.BILLING_PORTAL_FALLBACK !== "1")
      throw new HttpError(404, "The billing portal has moved in-app.");
    const orgId = await getActiveOrgId();
    if (!orgId) throw new HttpError(400, "No active organization");
    await requireOrgRole(orgId, ["owner"]);

    const [[sub], [org]] = await Promise.all([
      sql<{ stripe_customer_id: string | null }[]>`
        select stripe_customer_id from subscriptions where org_id = ${orgId}`,
      sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`,
    ]);
    if (!sub?.stripe_customer_id)
      throw new HttpError(
        400,
        "No billing account found. Complete checkout first.",
      );

    const session = await getStripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${baseUrl(req)}${routes.billing(org.slug)}`,
    });

    return { url: session.url };
  });
}

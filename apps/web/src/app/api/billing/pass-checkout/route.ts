import { z } from "zod";
import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { buildPassCheckoutParams } from "@/lib/billing";
import { preferredCurrency } from "@/lib/currency-server";
import { routes } from "@/lib/routes";

const schema = z.object({ competition_id: z.string().uuid() }).strict();

/** POST /api/billing/pass-checkout — start an EMBEDDED one-time Event Pass
 *  checkout for a single competition (v3/07 §3) and return its client_secret.
 *  Same embedded_page + reconcile-on-return contract as the Pro checkout. */
export async function POST(req: Request) {
  return handler(async () => {
    const orgId = await getActiveOrgId();
    if (!orgId) throw new HttpError(400, "No active organization");

    // Only owners may spend the org's money.
    const { user } = await requireOrgRole(orgId, ["owner"]);
    const { competition_id } = schema.parse(await req.json());

    const [comp] = await sql<{ slug: string; org_id: string }[]>`
      select slug, org_id from competitions where id = ${competition_id}`;
    if (!comp || comp.org_id !== orgId) throw new HttpError(404, "competition not found");

    // A Pro org has nothing to gain from a pass (v3/07 §3 interplay).
    const [sub] = await sql<
      { plan_key: string | null; stripe_customer_id: string | null }[]
    >`select plan_key, stripe_customer_id from subscriptions where org_id = ${orgId}`;
    if (sub?.plan_key && sub.plan_key !== "community") {
      throw new HttpError(400, "Your plan already covers everything an Event Pass adds.");
    }

    const [pass] = await sql<{ competition_id: string }[]>`
      select competition_id from competition_passes where competition_id = ${competition_id}`;
    if (pass) throw new HttpError(400, "This competition already has an Event Pass.");

    const [price] = await sql<{ price_id: string | null }[]>`
      select stripe_price_id_onetime as price_id from plans where key = 'event_pass'`;
    if (!price?.price_id) {
      throw new HttpError(503, "Billing is not yet configured. Please contact support.");
    }

    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${orgId}`;
    const returnUrl =
      `${baseUrl(req)}${routes.competitionUpgrade(org.slug, comp.slug)}` +
      `?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    const session = await getStripe().checkout.sessions.create(
      buildPassCheckoutParams({
        priceId: price.price_id,
        orgId,
        competitionId: competition_id,
        returnUrl,
        currency: await preferredCurrency(orgId, req),
        customerId: sub?.stripe_customer_id ?? undefined,
        customerEmail: user.email,
      }),
      // Scope the key to the REQUESTING owner (org+comp+user). A double-click /
      // retry of the SAME owner's purchase still reuses one session (dedup,
      // ~24h). But two DIFFERENT owners racing the same comp send different
      // params (per-user customer_email) — an org+comp-only key would collide
      // and 400 on the param mismatch, so each owner mints a DISTINCT session;
      // the losing duplicate is caught by the pass auto-refund (P0-3b).
      { idempotencyKey: `pass-checkout-${orgId}-${competition_id}-${user.id}` },
    );

    return { client_secret: session.client_secret };
  });
}

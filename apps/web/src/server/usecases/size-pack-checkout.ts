import "server-only";
import type Stripe from "stripe";
import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { routes } from "@/lib/routes";
import { preferredCurrency } from "@/lib/currency-server";
import { buildSizePackCheckoutParams, getSizePack, resolveSizePackPriceId } from "@/lib/size-packs";

/**
 * Open a one-time size-pack Checkout Session for ONE competition (v17 Phase 3
 * Task 3b). A size pack buys entrant capacity for a single competition, exactly
 * like the Event Pass, so it reuses the Event Pass purchase gate: only an OWNER
 * of the competition's OWNING ORG may buy one, and the charge lands on the
 * group's saved card only when the buyer IS the group's payer (otherwise a
 * member owner could bill the association at will — the pass-checkout money
 * defence). The gate runs BEFORE any Stripe call: a caller who may not buy 403s
 * (non-owner) or 404s (comp not theirs) first.
 *
 * feature_key + delta_each are SNAPSHOTTED into the session metadata here (T1
 * lesson): the webhook grants exactly what was sold, so a later catalog edit
 * never changes an already-bought pack. The webhook (billing-events) is the
 * SINGLE writer of the resulting org_addons row.
 */
export async function createSizePackCheckout(args: {
  competitionId: string;
  sizePackKey: string;
  req: Request;
}): Promise<Stripe.Checkout.Session> {
  const orgId = await getActiveOrgId();
  if (!orgId) throw new HttpError(400, "No active organization");

  // Only owners may spend the org's money (same gate as pass-checkout).
  const { user } = await requireOrgRole(orgId, ["owner"]);

  // Comp → owning org. A caller may only buy for a competition their active org
  // owns; anything else is refused here, before any Stripe call.
  const [comp] = await sql<{ slug: string; name: string; org_id: string }[]>`
    select slug, name, org_id from competitions where id = ${args.competitionId}`;
  if (!comp || comp.org_id !== orgId) throw new HttpError(404, "competition not found");
  const targetOrgId = comp.org_id;

  // The admin-editable catalog row — read ONCE, here, to snapshot its shape into
  // the session metadata; the webhook never re-reads it to recompute a grant.
  const pack = await getSizePack(args.sizePackKey);
  if (!pack || !pack.active) throw new HttpError(400, `Unknown size pack: ${args.sizePackKey}`);
  const priceId = await resolveSizePackPriceId(pack.stripe_lookup_key);

  // Reuse pass-checkout's customer defence: the group's saved-card customer is
  // used ONLY when the buyer is the group's payer; anyone else checks out
  // against their own email so the group's card is never billed by a member.
  const [sub] = await sql<{ stripe_customer_id: string | null; owner_user_id: string | null }[]>`
    select s.stripe_customer_id, s.owner_user_id from subscriptions s
     join organizations o on o.subscription_id = s.id
     where o.id = ${orgId}`;
  const isPayer = !!sub?.owner_user_id && sub.owner_user_id === user.id;

  const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;
  const returnUrl =
    `${baseUrl(args.req)}${routes.competitionUpgrade(org!.slug, comp.slug)}` +
    `?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

  // 30-second idempotency bucket per (org, comp, pack): dedupes a double-click
  // of the SAME purchase, but a genuine second size pack for the same comp
  // moments later (buy +32 twice → +64) is never blocked (mirrors credit packs).
  const bucket = Math.floor(Date.now() / 30_000);
  return getStripe().checkout.sessions.create(
    buildSizePackCheckoutParams({
      priceId,
      sizePackKey: pack.key,
      targetOrgId,
      targetCompetitionId: args.competitionId,
      featureKey: pack.feature_key,
      deltaEach: pack.delta_each,
      competitionName: comp.name,
      returnUrl,
      currency: await preferredCurrency(orgId, args.req),
      customerId: (isPayer ? sub?.stripe_customer_id : null) ?? undefined,
      customerEmail: user.email,
    }),
    { idempotencyKey: `size-pack-checkout-${orgId}-${args.competitionId}-${pack.key}-${bucket}` },
  );
}

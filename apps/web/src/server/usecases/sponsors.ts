import "server-only";
// Sponsor CRM (v10 PROMPT-56): first-class sponsor rows with tiers +
// per-competition scoping. The branding blob (lib/org-branding) stays a
// read shim — resolveSponsors falls back to it only when the table has no
// rows for the org. Tiers and competition scoping are the Pro line
// (`sponsors.tiers`); the un-tiered partner strip is free on every plan.
// Monetization (`sponsors.monetize`) sells priced packages over the entry-fee
// Connect rail: destination charge, platform application fee, billing-events
// webhook activation.
import type Stripe from "stripe";
import { z } from "zod";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { brandingSponsors } from "@/lib/org-branding";
import { getStripe } from "@/lib/stripe";
import {
  sendSponsorInvoiceEmail,
  sendSponsorReceiptEmail,
  sendSponsorRefundEmail,
  sendSponsorDisputeAlertEmail,
  sendSponsorDisputeLostEmail,
  sendSponsorDisputeWonEmail,
} from "@/lib/email";
import { deferred } from "@/lib/deferred";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { applicationFeeCents, feePercentFor } from "./registrations";
import { recoverDisputedTransfer as recoverDisputedTransferCore } from "./dispute-recovery";

export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export interface SponsorRow {
  id: string;
  competition_id: string | null;
  name: string;
  url: string | null;
  logo_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: "active" | "pending" | "inactive";
  click_count: number;
  created_at: string;
  /** The paid order that activated this placement, when it was bought
   *  through a package (list reads only — write paths return it unset). */
  paid_order_id?: string | null;
  /** Terminal outcome: a lost dispute wrote the paid order off — the
   *  placement stayed down and the row explains why (list reads only). */
  dispute_lost?: boolean;
  /** True while that order carries an OPEN dispute (paid + disputed_at):
   *  the placement was parked by the dispute handler, not by the manager.
   *  Cleared when the dispute is won; a lost dispute flips the order off
   *  'paid' so this goes false with it (list reads only). */
  dispute_parked?: boolean;
}

const COLS = [
  "id", "competition_id", "name", "url", "logo_path",
  "tier", "display_order", "status", "click_count", "created_at",
] as const;

export const CreateSponsorInput = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500).nullish(),
  logo_path: z.string().max(500).nullish(),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  competition_id: z.string().uuid().nullish(),
  status: z.enum(["active", "pending", "inactive"]).default("active"),
});
export type CreateSponsorInput = z.infer<typeof CreateSponsorInput>;

export const PatchSponsorInput = CreateSponsorInput.partial();
export type PatchSponsorInput = z.infer<typeof PatchSponsorInput>;

export const ReorderSponsorsInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderSponsorsInput = z.infer<typeof ReorderSponsorsInput>;

/** Tiers above `partner` and per-competition scoping are Pro
 *  (`sponsors.tiers`). Passing the competition lets an Event Pass lift the
 *  gate for its own competition, mirroring entry fees.
 *
 *  NOTE the asymmetry, which is intended and newly reachable: a non-partner
 *  tier with a NULL `competition_id` resolves ORG-WIDE. There is no competition
 *  to hand the resolver, so a pass holder gets the community answer and a 402 —
 *  the pass buys a tier ON ITS OWN COMPETITION, not org-wide sponsor tiers, and
 *  granting it here would be the leak the pass-scoping guard exists to stop.
 *
 *  This used to be unreachable: the settings tab hid the control from pass
 *  holders entirely. It now offers it (page.tsx asks `hasFeatureOnAnyPass`, an
 *  affordance question), so a pass holder CAN save an unscoped tiered sponsor
 *  and be refused. That surfaces as an error toast, not a silent no-op, so the
 *  failure is legible — pick the competition and it saves. */
async function assertTierAllowed(
  orgId: string,
  tier: SponsorTier | undefined,
  competitionId: string | null | undefined,
): Promise<void> {
  if ((tier && tier !== "partner") || competitionId != null) {
    await requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined);
  }
}

/** The competition an existing sponsor already sits on, so a patch that only
 *  moves the TIER is still judged against a competition. Tenant-scoped: a
 *  sponsor id from another org resolves to null, never to that org's scope. */
async function sponsorCompetitionId(orgId: string, id: string): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<{ competition_id: string | null }[]>`
      select competition_id from sponsors where id = ${id}`;
    return row?.competition_id ?? null;
  });
}

/** Sponsor edits must show on the public tree promptly — same cache bust the
 *  org-branding PATCH fires (tail work; slug lookup included). */
function bustPublicSponsors(orgId: string): void {
  deferred(async () => {
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${orgId}`;
    if (org) fireOrgRevalidate(org.slug);
  });
}

/** Plain read for server pages (settings) — same rows as listSponsors.
 *  paid_order_id links a placement back to the package order that bought
 *  it, so the manager can mark it and guard its deletion. */
export async function listSponsorRows(orgId: string): Promise<SponsorRow[]> {
  return withTenant(orgId, (tx) => tx<SponsorRow[]>`
    select ${tx(COLS)},
           (select o.id from sponsor_orders o
            where o.sponsor_id = sponsors.id and o.status = 'paid'
            limit 1) as paid_order_id,
           exists(select 1 from sponsor_orders o
                  where o.sponsor_id = sponsors.id and o.status = 'paid'
                    and o.disputed_at is not null) as dispute_parked,
           exists(select 1 from sponsor_orders o
                  where o.sponsor_id = sponsors.id and o.status = 'refunded'
                    and o.dispute_id is not null) as dispute_lost
    from sponsors
    order by array_position(array['title','gold','silver','partner'], tier),
             display_order, created_at, id`);
}

export async function listSponsors(auth: AuthCtx): Promise<SponsorRow[]> {
  return listSponsorRows(auth.orgId);
}

export async function createSponsor(
  auth: AuthCtx,
  input: CreateSponsorInput,
): Promise<SponsorRow> {
  await assertTierAllowed(auth.orgId, input.tier, input.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    if (input.competition_id) {
      const [comp] = await tx`select 1 from competitions where id = ${input.competition_id}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    const [row] = await tx<SponsorRow[]>`
      insert into sponsors (org_id, competition_id, name, url, logo_path,
                            tier, display_order, status)
      values (${auth.orgId}, ${input.competition_id ?? null}, ${input.name},
              ${input.url ?? null}, ${input.logo_path ?? null}, ${input.tier},
              (select coalesce(max(display_order), -1) + 1 from sponsors
               where competition_id is not distinct from ${input.competition_id ?? null}
                 and tier = ${input.tier}),
              ${input.status})
      returning ${tx(COLS)}`;
    return row!;
  }).then((row) => {
    bustPublicSponsors(auth.orgId);
    return row;
  });
}

export async function patchSponsor(
  auth: AuthCtx,
  id: string,
  patch: PatchSponsorInput,
): Promise<SponsorRow> {
  const cols = Object.keys(patch);
  if (cols.length === 0) throw new HttpError(400, "empty patch");
  // Gate only what the patch introduces: promoting to a paid tier or scoping
  // to a competition needs sponsors.tiers. Editing name/url/logo on an
  // existing tiered sponsor stays allowed after a downgrade.
  //
  // The scope is the competition the sponsor ENDS UP on — the patch's own
  // `competition_id` when the patch sets one, otherwise the row's existing one.
  // Reading only the patch resolved a plain `{ tier: "title" }` promotion
  // ORG-WIDE, and lib/entitlements.ts consults `competition_passes` only when a
  // competition is in scope, so an Event Pass holder was refused the promotion
  // on the very competition they had paid to tier. The pass-scoping guard could
  // not see it: the argument was present, just carrying `undefined`.
  //
  // The extra read costs one query, and only on a promotion that does not
  // already name a competition — `{ name }` / `{ status }` patches are
  // untouched. Unscoping (`competition_id: null`) still resolves org-wide and
  // is still refused; that asymmetry is deliberate, see assertTierAllowed.
  const scope =
    "competition_id" in patch
      ? patch.competition_id
      : patch.tier && patch.tier !== "partner"
        ? await sponsorCompetitionId(auth.orgId, id)
        : undefined;
  await assertTierAllowed(auth.orgId, patch.tier, scope);
  return withTenant(auth.orgId, async (tx) => {
    // A placement parked by an open dispute stays down until the dispute
    // closes — reactivating it by hand would put a charged-back sponsor
    // back on boards and public pages.
    if (patch.status === "active") {
      const [open] = await tx`
        select 1 from sponsor_orders o
        where o.sponsor_id = ${id} and o.status = 'paid'
          and o.disputed_at is not null limit 1`;
      if (open) {
        throw new HttpError(
          409,
          "this placement is parked by an open payment dispute — it comes back automatically if the dispute is won",
        );
      }
    }
    const [row] = await tx<SponsorRow[]>`
      update sponsors set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "sponsor not found");
    return row;
  }).then((row) => {
    bustPublicSponsors(auth.orgId);
    return row;
  });
}

export async function deleteSponsor(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from sponsors where id = ${id} returning id`;
    if (!row) throw new HttpError(404, "sponsor not found");
  }).then(() => bustPublicSponsors(auth.orgId));
}

/** Persist a new display order: `ids` in the order they should render.
 *  Order is scoped per (scope, tier) group by the reads, so indices are
 *  simply assigned in sequence — groups keep their relative order. */
export async function reorderSponsors(
  auth: AuthCtx,
  input: ReorderSponsorsInput,
): Promise<{ reordered: number }> {
  return withTenant(auth.orgId, async (tx) => {
    let reordered = 0;
    for (let i = 0; i < input.ids.length; i++) {
      const [row] = await tx<{ id: string }[]>`
        update sponsors set display_order = ${i}
        where id = ${input.ids[i]!} returning id`;
      if (!row) throw new HttpError(422, "reorder references an unknown sponsor");
      reordered++;
    }
    return { reordered };
  }).then((res) => {
    bustPublicSponsors(auth.orgId);
    return res;
  });
}

// ---------------------------------------------------------------------------
// Public resolver (placement) — DB rows first, blob shim as fallback
// ---------------------------------------------------------------------------

export interface ResolvedSponsor {
  id: string | null; // null = blob-shim entry (no tracked redirect)
  name: string;
  url: string | null;
  logo: string | null;
  tier: SponsorTier;
}

/**
 * Sponsors for a public surface: competition-scoped rows first, then
 * org-wide, deduped by name, ordered tier rank → display_order. Falls back
 * to the branding blobs ONLY when the org has no table rows at all
 * (belt-and-braces during rollout — the backfill normally seeds them).
 * Runs on the privileged connection: public pages have no tenant context.
 * Orgs without `sponsors.tiers` get the un-tiered free strip — every row
 * collapses to `partner` so tier grouping stays a Pro-visible feature.
 */
export async function resolveSponsors(
  orgId: string,
  competitionId?: string,
  opts: { tiered?: boolean } = {},
): Promise<ResolvedSponsor[]> {
  const rows = await sql<
    (Pick<SponsorRow, "id" | "name" | "url" | "tier"> & { logo_path: string | null })[]
  >`
    select id, name, url, logo_path, tier from sponsors
    where org_id = ${orgId} and status = 'active'
      and (competition_id is null or competition_id = ${competitionId ?? null})
    order by (competition_id is null),
             array_position(array['title','gold','silver','partner'], tier),
             display_order, created_at, id`;

  let resolved: ResolvedSponsor[];
  if (rows.length > 0) {
    resolved = rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      logo: r.logo_path,
      tier: r.tier,
    }));
  } else {
    // Blob shim: competition blob first then org blob, like the old render.
    const [org] = await sql<{ branding: unknown }[]>`
      select branding from organizations where id = ${orgId}`;
    const comp = competitionId
      ? await sql<{ branding: unknown }[]>`
          select branding from competitions where id = ${competitionId}`
      : [];
    resolved = [...brandingSponsors(comp[0]?.branding), ...brandingSponsors(org?.branding)].map(
      (s) => ({
        id: null,
        name: s.name,
        url: s.url ?? null,
        logo: s.logo ?? null,
        tier: "partner" as const,
      }),
    );
  }

  const seen = new Set<string>();
  const deduped = resolved.filter((s) => !seen.has(s.name) && seen.add(s.name));
  if (opts.tiered === false) {
    return deduped.map((s) => ({ ...s, tier: "partner" as const }));
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Monetization (Pro `sponsors.monetize`) — packages + Connect checkout
// ---------------------------------------------------------------------------

export interface SponsorPackageRow {
  id: string;
  competition_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  tier: SponsorTier;
  active: boolean;
  created_at: string;
}

const PKG_COLS = [
  "id", "competition_id", "name", "description", "price_cents",
  "currency", "tier", "active", "created_at",
] as const;

export const CreateSponsorPackageInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  price_cents: z.number().int().positive().max(5_000_000),
  currency: z.string().length(3).toLowerCase().default("gbp"),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  competition_id: z.string().uuid().nullish(),
});
export type CreateSponsorPackageInput = z.infer<typeof CreateSponsorPackageInput>;

export const StartSponsorCheckoutInput = z.object({
  package_id: z.string().uuid(),
  sponsor_name: z.string().min(1).max(80),
  sponsor_email: z.string().email().max(320),
});
export type StartSponsorCheckoutInput = z.infer<typeof StartSponsorCheckoutInput>;

export async function createSponsorPackage(
  auth: AuthCtx,
  input: CreateSponsorPackageInput,
): Promise<SponsorPackageRow> {
  await requireFeature(auth.orgId, "sponsors.monetize", input.competition_id ?? undefined);
  return withTenant(auth.orgId, async (tx) => {
    if (input.competition_id) {
      const [comp] = await tx`select 1 from competitions where id = ${input.competition_id}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    const [row] = await tx<SponsorPackageRow[]>`
      insert into sponsor_packages (org_id, competition_id, name, description,
                                    price_cents, currency, tier)
      values (${auth.orgId}, ${input.competition_id ?? null}, ${input.name},
              ${input.description ?? null}, ${input.price_cents},
              ${input.currency}, ${input.tier})
      returning ${tx(PKG_COLS)}`;
    return row!;
  });
}

export async function listSponsorPackages(auth: AuthCtx): Promise<SponsorPackageRow[]> {
  return withTenant(auth.orgId, (tx) => tx<SponsorPackageRow[]>`
    select ${tx(PKG_COLS)} from sponsor_packages
    order by active desc, created_at desc, id`);
}

/** Packages are referenced by orders, so retiring one is a soft flip. */
export async function deactivateSponsorPackage(
  auth: AuthCtx,
  id: string,
): Promise<SponsorPackageRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorPackageRow[]>`
      update sponsor_packages set active = false
      where id = ${id} returning ${tx(PKG_COLS)}`;
    if (!row) throw new HttpError(404, "package not found");
    return row;
  });
}

export interface SponsorOrderRow {
  id: string;
  package_id: string;
  sponsor_name: string;
  sponsor_email: string;
  payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  sponsor_id: string | null;
  created_at: string;
  paid_at: string | null;
  disputed_at: string | null;
  dispute_id: string | null;
}

const ORDER_COLS = [
  "id", "package_id", "sponsor_name", "sponsor_email", "payment_intent_id",
  "amount_cents", "currency", "status", "sponsor_id", "created_at", "paid_at",
  "disputed_at", "dispute_id",
] as const;

export async function listSponsorOrders(auth: AuthCtx): Promise<SponsorOrderRow[]> {
  return withTenant(auth.orgId, (tx) => tx<SponsorOrderRow[]>`
    select ${tx(ORDER_COLS)} from sponsor_orders
    order by created_at desc, id`);
}

/**
 * Start a package checkout: order row FIRST (pending), then the Stripe
 * Checkout Session as a destination charge on the org's connected account —
 * amount to the org, platform keeps the entry-fee application fee, exactly
 * like registrations. Stripe is called OUTSIDE any sql transaction; the
 * idempotency key `sponsor-order-<id>` pins retries to one session. The
 * sponsor contact gets a pay-now invoice email.
 */
export async function startSponsorCheckout(
  auth: AuthCtx,
  input: StartSponsorCheckoutInput,
  origin: string,
): Promise<{ order: SponsorOrderRow; checkout_url: string }> {
  const pkg = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorPackageRow[]>`
      select ${tx(PKG_COLS)} from sponsor_packages where id = ${input.package_id}`;
    if (!row) throw new HttpError(404, "package not found");
    if (!row.active) throw new HttpError(422, "This package is no longer on sale");
    return row;
  });
  await requireFeature(auth.orgId, "sponsors.monetize", pkg.competition_id ?? undefined);

  // Connect gate (v9 ordering): the org must be onboarded — same refusal as
  // entry fees — before any order exists. The ToS chargeback clause was
  // accepted when the Express account was created (createConnectOnboardingLink).
  const [org] = await sql<
    { slug: string; name: string; stripe_account_id: string | null; stripe_charges_enabled: boolean }[]
  >`
    select slug, name, stripe_account_id, stripe_charges_enabled
    from organizations where id = ${auth.orgId}`;
  if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
    throw new HttpError(409, "Connect Stripe (Get paid) before selling sponsorship packages");
  }

  const order = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorOrderRow[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email,
                                  amount_cents, currency)
      values (${auth.orgId}, ${pkg.id}, ${input.sponsor_name}, ${input.sponsor_email},
              ${pkg.price_cents}, ${pkg.currency})
      returning ${tx(ORDER_COLS)}`;
    return row!;
  });

  const returnBase = `${origin}/shared/${org.slug}`;
  const session = await getStripe().checkout.sessions.create(
    {
      mode: "payment",
      customer_email: input.sponsor_email,
      metadata: { kind: "sponsor", order_id: order.id, org_id: auth.orgId },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: pkg.currency,
            unit_amount: pkg.price_cents,
            product_data: { name: `${pkg.name} — sponsorship (${input.sponsor_name})` },
          },
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeCents(
          pkg.price_cents,
          await feePercentFor(auth.orgId, pkg.competition_id ?? undefined),
        ),
        transfer_data: { destination: org.stripe_account_id },
        metadata: {
          kind: "sponsor",
          order_id: order.id,
          package_id: pkg.id,
          org_id: auth.orgId,
        },
      },
      success_url: `${returnBase}?sponsorship=success`,
      cancel_url: `${returnBase}?sponsorship=cancelled`,
    },
    { idempotencyKey: `sponsor-order-${order.id}` },
  );
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");

  await sendSponsorInvoiceEmail({
    to: input.sponsor_email,
    orgName: org.name,
    packageName: pkg.name,
    sponsorName: input.sponsor_name,
    amountCents: pkg.price_cents,
    currency: pkg.currency,
    checkoutUrl: session.url,
  });

  return { order, checkout_url: session.url };
}

// ---------------------------------------------------------------------------
// Webhook activation (billing-events dispatch; replay-safe)
// ---------------------------------------------------------------------------

/**
 * payment_intent.succeeded with metadata.kind === 'sponsor': mark the order
 * paid and create the activated sponsor row at the package tier. Idempotent
 * under /admin/billing-events replay — belt (order already paid) and braces
 * (order already carries a sponsor_id) both short-circuit; Stripe's own
 * idempotency keys expire ~24h so this DB guard is the real one.
 */
export async function handleSponsorPaymentSucceeded(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  if (intent.metadata?.kind !== "sponsor") return;
  const orderId = intent.metadata.order_id;
  if (!orderId) return;

  const activated = await sql.begin(async (tx) => {
    const [order] = await tx<(SponsorOrderRow & { org_id: string })[]>`
      select ${sql(ORDER_COLS as unknown as string[])}, org_id
      from sponsor_orders where id = ${orderId} for update`;
    if (!order) return null;
    if (order.status === "paid" || order.sponsor_id !== null) return null;

    const [pkg] = await tx<{ name: string; tier: SponsorTier; competition_id: string | null }[]>`
      select name, tier, competition_id from sponsor_packages where id = ${order.package_id}`;
    if (!pkg) return null;

    const [sponsor] = await tx<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status, display_order)
      values (${order.org_id}, ${pkg.competition_id}, ${order.sponsor_name}, ${pkg.tier},
              'active',
              (select coalesce(max(display_order), -1) + 1 from sponsors
               where org_id = ${order.org_id}
                 and competition_id is not distinct from ${pkg.competition_id}
                 and tier = ${pkg.tier}))
      returning id`;
    await tx`
      update sponsor_orders
      set status = 'paid', paid_at = now(),
          payment_intent_id = coalesce(payment_intent_id, ${intent.id}),
          sponsor_id = ${sponsor!.id}
      where id = ${orderId}`;
    return { order, packageName: pkg.name };
  });
  if (!activated) return;

  const [org] = await sql<{ slug: string; name: string }[]>`
    select slug, name from organizations where id = ${activated.order.org_id}`;
  if (org) deferred(() => fireOrgRevalidate(org.slug));
  await sendSponsorReceiptEmail({
    to: activated.order.sponsor_email,
    orgName: org?.name ?? "the organiser",
    packageName: activated.packageName,
    sponsorName: activated.order.sponsor_name,
    amountCents: activated.order.amount_cents,
    currency: activated.order.currency,
    publicUrl: org ? `${sponsorEmailOrigin()}/shared/${org.slug}` : null,
  });
}

/** payment_intent.payment_failed for a sponsor order: pending → failed
 *  (a paid order is never clobbered by a stray late failure event). */
export async function handleSponsorPaymentFailed(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  if (intent.metadata?.kind !== "sponsor") return;
  const orderId = intent.metadata.order_id;
  if (!orderId) return;
  await sql`
    update sponsor_orders
    set status = 'failed', payment_intent_id = coalesce(payment_intent_id, ${intent.id})
    where id = ${orderId} and status = 'pending'`;
}

/**
 * Console-initiated refund (owner action): full refund of a paid order —
 * the transfer to the org reverses and the platform returns its
 * application fee, exactly like entry-fee refunds. The local flip reuses
 * the charge.refunded path, so the later Stripe event replays as a no-op.
 */
export async function refundSponsorOrder(
  auth: AuthCtx,
  orderId: string,
): Promise<SponsorOrderRow> {
  const order = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorOrderRow[]>`
      select ${tx(ORDER_COLS)} from sponsor_orders where id = ${orderId}`;
    if (!row) throw new HttpError(404, "order not found");
    return row;
  });
  if (order.status !== "paid" || !order.payment_intent_id) {
    throw new HttpError(422, "Only a paid order can be refunded");
  }
  // Stripe refuses refunds on charged-back charges; surface the state in our
  // own words before ever calling out (raw Stripe text leaked to the console).
  if (order.disputed_at) {
    throw new HttpError(
      409,
      "This payment has been charged back — a disputed payment can't be refunded. Respond to the dispute instead.",
    );
  }
  // Stripe OUTSIDE any sql transaction (house rule).
  await getStripe().refunds.create(
    {
      payment_intent: order.payment_intent_id,
      reverse_transfer: true,
      refund_application_fee: true,
    },
    { idempotencyKey: `sponsor-refund-${orderId}` },
  );
  await handleSponsorChargeRefunded({
    payment_intent: order.payment_intent_id,
    refunded: true,
  } as Stripe.Charge);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorOrderRow[]>`
      select ${tx(ORDER_COLS)} from sponsor_orders where id = ${orderId}`;
    return row!;
  });
}

/**
 * charge.refunded for a sponsor order (Stripe-dashboard refunds included):
 * flip the paid order to `refunded` and take the bought placement off the
 * public pages (status → inactive; the row survives as the audit trail).
 * Idempotent — only a `paid` order flips, and non-sponsor charges don't
 * match any order row.
 */
export async function handleSponsorChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return;
  const refunded = await sql.begin(async (tx) => {
    const [order] = await tx<
      {
        id: string;
        org_id: string;
        sponsor_id: string | null;
        sponsor_name: string;
        sponsor_email: string;
        amount_cents: number;
        currency: string;
        package_id: string;
      }[]
    >`
      update sponsor_orders
      set status = 'refunded'
      where payment_intent_id = ${intent} and status = 'paid'
      returning id, org_id, sponsor_id, sponsor_name, sponsor_email,
                amount_cents, currency, package_id`;
    if (!order) return null;
    if (order.sponsor_id) {
      await tx`update sponsors set status = 'inactive' where id = ${order.sponsor_id}`;
    }
    return order;
  });
  if (!refunded) return;
  const [org] = await sql<{ slug: string; name: string }[]>`
    select slug, name from organizations where id = ${refunded.org_id}`;
  if (org) deferred(() => fireOrgRevalidate(org.slug));
  const [pkg] = await sql<{ name: string }[]>`
    select name from sponsor_packages where id = ${refunded.package_id}`;
  await sendSponsorRefundEmail({
    to: refunded.sponsor_email,
    orgName: org?.name ?? "the organiser",
    packageName: pkg?.name ?? "sponsorship",
    sponsorName: refunded.sponsor_name,
    amountCents: refunded.amount_cents,
    currency: refunded.currency,
  });
}

// ---------------------------------------------------------------------------
// Dispute lifecycle (payments-hardening Task 6, P0-2)
// ---------------------------------------------------------------------------

/** Origin for sponsor emails fired from webhook (request-less) paths — the
 *  same override order as registrations' fallbackOrigin. NEXT_PUBLIC_APP_URL
 *  (the previous source) is not set in any environment, so receipts went out
 *  with relative "/shared/…" links no mail client could open. */
function sponsorEmailOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Current owner via org_members, NOT organizations.created_by — an ownership
 *  transfer flips the role but leaves created_by on the original creator. Local
 *  copy (registrations.ts keeps its own too): importing billing-events'
 *  orgOwnerEmail would make sponsors ⇄ billing-events a circular import. */
async function currentOrgOwnerEmail(orgId: string): Promise<string | null> {
  const [owner] = await sql<{ email: string }[]>`
    select u.email from org_members m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.role = 'owner' limit 1`;
  return owner?.email ?? null;
}

async function resolveOrgName(orgId: string): Promise<string | null> {
  const [org] = await sql<{ name: string }[]>`
    select name from organizations where id = ${orgId}`;
  return org?.name ?? null;
}

async function resolvePackageName(packageId: string): Promise<string> {
  const [pkg] = await sql<{ name: string }[]>`
    select name from sponsor_packages where id = ${packageId}`;
  return pkg?.name ?? "sponsorship";
}

/** Actorless audit breadcrumb for a sponsor recovery, on the same
 *  competition_events ledger the registration recovery writes to. A sponsor
 *  package can be org-wide (no competition) and there is no actorless
 *  org-scoped audit table (staff_audit_log needs a staff actor), so an org-wide
 *  order records no breadcrumb — the money records on sponsor_orders stay the
 *  source of truth. Must NOT throw (the core's auditNote contract). */
async function auditSponsorRecovery(
  order: { org_id: string; competition_id: string | null },
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!order.competition_id) return;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${order.competition_id}, ${order.org_id}, ${type},
            ${sql.json(payload as never)}, ${null})`;
}

/** Sponsor-flavoured wrapper over the shared dispute-recovery core
 *  (dispute-recovery.ts, Task 5): the charge→transfer→reversal mechanics and
 *  the dispute_id replay guard live in the core; this namespaces the audit
 *  under `sponsor.` and tags the reversal with sponsor_order_id. Never throws;
 *  Stripe calls stay OUTSIDE any sql tx. */
async function recoverSponsorDispute(
  dispute: Stripe.Dispute,
  order: { id: string; org_id: string; competition_id: string | null },
): Promise<{ recoveredCents: number; already: boolean }> {
  return recoverDisputedTransferCore(dispute, {
    auditNote: (type, extra) =>
      auditSponsorRecovery(order, `sponsor.${type}`, { order_id: order.id, ...extra }),
    reversalMetadata: { sponsor_order_id: order.id },
  });
}

/**
 * charge.dispute.created / .closed for a sponsor package charge (P0-2 —
 * destination charges make the PLATFORM liable, exactly like entry fees).
 * `created` flags the order + parks the placement (pending) and alerts the
 * owner; `closed` clears the flag and re-activates on a win, or writes the
 * order off, deactivates the placement and reverses the club's transfer on a
 * loss. Dispatched after handleRegistrationDispute for both event types —
 * a non-sponsor intent matches no order row and no-ops.
 *
 * Replay-safe: the disputed_at/dispute_id + status writes converge, the
 * created alert fires only on the first flag of a given dispute, and the lost
 * recovery + its email short-circuit on the core's dispute_id metadata guard.
 * Stripe calls stay OUTSIDE any sql tx.
 */
export async function handleSponsorDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intent) return false;
  const [order] = await sql<
    (SponsorOrderRow & {
      org_id: string;
      disputed_at: Date | null;
      dispute_id: string | null;
      competition_id: string | null;
    })[]
  >`
    select ${sql(ORDER_COLS as unknown as string[])}, org_id, disputed_at, dispute_id,
           (select competition_id from sponsor_packages p where p.id = sponsor_orders.package_id)
             as competition_id
    from sponsor_orders where payment_intent_id = ${intent}`;
  if (!order) return false; // not a sponsor charge (or it doesn't know its intent YET)

  if (phase === "created") {
    // A replayed created event re-stamps nothing new: coalesce keeps the first
    // flag time and the alert / placement park run only the first time.
    const firstFlag = order.dispute_id !== dispute.id;
    await sql`update sponsor_orders
              set disputed_at = coalesce(disputed_at, now()), dispute_id = ${dispute.id}
              where id = ${order.id}`;
    if (firstFlag) {
      if (order.sponsor_id) {
        await sql`update sponsors set status = 'pending' where id = ${order.sponsor_id}`;
      }
      const owner = await currentOrgOwnerEmail(order.org_id);
      if (owner) {
        void sendSponsorDisputeAlertEmail({
          to: owner,
          orgName: (await resolveOrgName(order.org_id)) ?? "your organisation",
          packageName: await resolvePackageName(order.package_id),
          sponsorName: order.sponsor_name,
          amountCents: dispute.amount,
          currency: order.currency,
        }).catch(() => {});
      }
    }
    bustPublicSponsors(order.org_id);
    return true;
  }

  if (dispute.status === "won") {
    // First transition only (replay-safe): the row still carried the flag.
    const firstClear = order.disputed_at !== null;
    await sql`update sponsor_orders set disputed_at = null where id = ${order.id}`;
    if (order.sponsor_id) {
      await sql`update sponsors set status = 'active' where id = ${order.sponsor_id}`;
    }
    if (firstClear) {
      const owner = await currentOrgOwnerEmail(order.org_id);
      if (owner) {
        void sendSponsorDisputeWonEmail({
          to: owner,
          orgName: (await resolveOrgName(order.org_id)) ?? "your organisation",
          packageName: await resolvePackageName(order.package_id),
          sponsorName: order.sponsor_name,
          amountCents: dispute.amount,
          currency: order.currency,
        }).catch(() => {});
      }
    }
    bustPublicSponsors(order.org_id);
    return true;
  }

  if (dispute.status === "lost") {
    // The write-off must land whatever Stripe does next — same contract as the
    // registration dispute-lost path. Both flips are idempotent under replay.
    await sql`update sponsor_orders set status = 'refunded' where id = ${order.id}`;
    if (order.sponsor_id) {
      await sql`update sponsors set status = 'inactive' where id = ${order.sponsor_id}`;
    }
    const recovery = await recoverSponsorDispute(dispute, order);
    // `already` = a replayed close (metadata guard hit) — the write-off + email
    // already happened on the first run.
    if (!recovery.already) {
      const owner = await currentOrgOwnerEmail(order.org_id);
      if (owner) {
        void sendSponsorDisputeLostEmail({
          to: owner,
          orgName: (await resolveOrgName(order.org_id)) ?? "your organisation",
          packageName: await resolvePackageName(order.package_id),
          sponsorName: order.sponsor_name,
          amountCents: dispute.amount,
          currency: order.currency,
          recoveredCents: recovery.recoveredCents,
        }).catch(() => {});
      }
    }
    bustPublicSponsors(order.org_id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dispute evidence pack — sponsor twin of registrations' buildDisputeEvidence
// ---------------------------------------------------------------------------

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function evRow(label: string, value: string): string {
  return `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(label)}</td><td style="padding:6px 0;font-weight:600">${escHtml(value)}</td></tr>`;
}

/**
 * Everything the platform holds that shows a disputed sponsorship was
 * genuine, as one printable HTML document mapped to Stripe's evidence
 * fields: the order record, the reconstructed payment receipt (customer
 * communication), the placement's delivery proof (live period, public page,
 * click count) and the audit trail. Organisers download it from the
 * disputed order row and paste/upload into the dispute response.
 */
export async function buildSponsorDisputeEvidence(
  auth: AuthCtx,
  orderId: string,
  origin: string,
): Promise<{ ref: string; html: string }> {
  const order = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      (SponsorOrderRow & { dispute_id: string | null })[]
    >`select ${tx(ORDER_COLS)}, dispute_id from sponsor_orders where id = ${orderId}`;
    if (!row) throw new HttpError(404, "order not found");
    return row;
  });
  const [pkg] = await sql<
    { name: string; tier: SponsorTier; competition_id: string | null }[]
  >`select name, tier, competition_id from sponsor_packages where id = ${order.package_id}`;
  const [org] = await sql<{ name: string; slug: string }[]>`
    select name, slug from organizations where id = ${auth.orgId}`;
  const [comp] = pkg?.competition_id
    ? await sql<{ name: string; slug: string }[]>`
        select name, slug from competitions where id = ${pkg.competition_id}`
    : [undefined];
  const [placement] = order.sponsor_id
    ? await sql<{ tier: string; status: string; click_count: number; created_at: Date }[]>`
        select tier, status, click_count, created_at from sponsors where id = ${order.sponsor_id}`
    : [undefined];

  const events = await sql<{ type: string; payload: unknown; created_at: Date }[]>`
    select e.type, e.payload, e.created_at
    from competition_events e
    join competitions c on c.id = e.competition_id
    where c.org_id = ${auth.orgId} and e.payload->>'order_id' = ${orderId}
    order by e.created_at`;

  // The receipt, reconstructed with the exact sender inputs (sponsor emails
  // are sent in en — orders carry no locale).
  const { sponsorReceiptTemplate } = await import("@/lib/email-templates/sponsor-receipt");
  const { getDictionary } = await import("@/lib/i18n");
  const publicUrl = org ? `${origin}/shared/${org.slug}` : null;
  const emailText = sponsorReceiptTemplate(
    {
      orgName: org?.name ?? "the organiser",
      packageName: pkg?.name ?? "sponsorship",
      sponsorName: order.sponsor_name,
      amountCents: order.amount_cents,
      currency: order.currency,
      publicUrl,
    },
    await getDictionary("en", "emails"),
  ).text;

  const when = (d: Date | string | null) => (d ? new Date(d).toISOString() : "—");
  const ref = orderId.slice(0, 8);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dispute evidence — sponsorship ${escHtml(ref)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18181b">
<div style="background:#150b36;color:#f5f0e8;padding:18px 32px 8px">
  <div style="font-size:18px;font-weight:800;letter-spacing:2px">SEAZN <span style="color:#a3e635">CLUB</span></div>
  <div style="text-align:right;color:#ef4444;font-size:14px;line-height:8px">&#9679;</div>
</div>
<div style="height:4px;background:#a3e635"></div>
<div style="max-width:760px;margin:0 auto;padding:28px 32px">
  <h1 style="font-size:22px;margin:0 0 2px">Dispute evidence pack — sponsorship ${escHtml(ref)}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px">
    Generated ${new Date().toISOString()} · ${escHtml(org?.name ?? "")} · for the Stripe dispute response${order.dispute_id ? ` (${escHtml(order.dispute_id)})` : ""}.
  </p>

  <h2 style="font-size:15px;margin:20px 0 6px">Sponsorship order (product/service + customer)</h2>
  <table style="font-size:14px;border-collapse:collapse">
    ${evRow("Order", orderId)}
    ${evRow("Sponsor", order.sponsor_name)}
    ${evRow("Customer email", order.sponsor_email)}
    ${evRow("Package", `${pkg?.name ?? "—"} (${pkg?.tier ?? "—"})`)}
    ${evRow("Scope", comp ? comp.name : "whole organisation")}
    ${evRow("Amount", `${(order.amount_cents / 100).toFixed(2)} ${order.currency.toUpperCase()}`)}
    ${evRow("Payment intent", order.payment_intent_id ?? "—")}
    ${evRow("Ordered at", when(order.created_at))}
    ${evRow("Paid at", when(order.paid_at))}
    ${evRow("Status", order.status)}
    ${evRow("Disputed at", when(order.disputed_at ?? null))}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Receipt email (customer communication)</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:12px">Reconstruction of the transactional receipt sent to ${escHtml(order.sponsor_email)} on payment.</p>
  <pre style="background:#f6f5f8;border-radius:8px;padding:14px;font-size:12px;white-space:pre-wrap">${escHtml(emailText)}</pre>

  <h2 style="font-size:15px;margin:24px 0 6px">Placement delivered (service provided)</h2>
  ${
    placement
      ? `<table style="font-size:14px;border-collapse:collapse">
    ${evRow("Placement tier", placement.tier)}
    ${evRow("Live from", when(order.paid_at))}
    ${evRow("Current state", placement.status === "pending" ? "parked by this dispute" : placement.status)}
    ${evRow("Public page", publicUrl ?? "—")}
    ${evRow("Logo clicks recorded", String(placement.click_count))}
  </table>`
      : `<p style="color:#6b7280;font-size:13px;margin:0">No placement row (payment did not activate one).</p>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">Activity log (${events.length})</h2>
  ${
    events.length === 0
      ? `<p style="color:#6b7280;font-size:13px;margin:0">No competition-scoped events reference this order.</p>`
      : `<table style="font-size:13px;border-collapse:collapse">${events
          .map((e) =>
            evRow(new Date(e.created_at).toISOString(), `${e.type} ${JSON.stringify(e.payload)}`),
          )
          .join("")}</table>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">How to use</h2>
  <ol style="font-size:13px;color:#374151;padding-left:18px;margin:0">
    <li>Open the dispute in your Stripe Dashboard (platform account).</li>
    <li>Product/service: paste the Sponsorship order section; the service is the placement period above.</li>
    <li>Customer communication / receipt: paste the receipt reconstruction.</li>
    <li>Placement + activity log: upload this document as supporting evidence.</li>
  </ol>
</div>
</body></html>`;

  return { ref, html };
}

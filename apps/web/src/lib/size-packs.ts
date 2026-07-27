import "server-only";
import type Stripe from "stripe";
import type postgres from "postgres";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

/** A DB executor for the catalog writes: the shared `sql` client, or a
 *  transaction handle when the caller (an admin route) wants the write and its
 *  staff_audit_log row to commit atomically (extend #272). */
type Exec = postgres.TransactionSql | typeof sql;
import { CHECKOUT_BRANDING, CUSTOMER_UPDATE_FOR_TAX } from "@/lib/billing";
import { SEAT_ADDON } from "@/lib/seat-addons";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";

/** Caps whose `org_addons` rows are owned by a RECURRING WEBHOOK SWEEP. Each of
 *  these has a `customer.subscription.updated` handler that cancels every
 *  active row on the wallet for its feature key whose Stripe subscription ITEM
 *  it no longer sees:
 *
 *   - `members.max`     -> syncSeatAddonsForSubscription (extra seats)
 *   - `orgs.max_owned`  -> syncOrgAddonsForSubscription  (extra organisations,
 *                          v17 gap #293 — the same sweep, added by W6)
 *
 *  Read from the two catalogs rather than restated, so a key that moves moves
 *  here too. */
const SWEEP_MANAGED_FEATURE_KEYS: readonly string[] = [
  SEAT_ADDON.featureKey,
  ORG_ADDON_FEATURE_KEY,
];

/** A size-pack may lift any additive cap EXCEPT one that a subscription sweep
 *  manages. A size-pack is a ONE-TIME purchase: `grantSizePackAddon` writes an
 *  org_addons row on the buyer's wallet with a non-null `stripe_item_id` (the
 *  payment_intent id) and status 'active' — precisely the shape both sweeps
 *  cancel — and a one-time id is never in either sweep's seen-set, which only
 *  ever contains live subscription item ids. So a size-pack pointed at one of
 *  these caps is silently canceled by the very next `subscription.updated` on
 *  the same group, after the customer has paid.
 *
 *  `feature_key` is admin-configurable (owner intent) for every OTHER cap, and
 *  admin-editable is exactly why this is enforced at write time rather than
 *  documented: it is reachable today through the staff catalog CRUD. Forbid
 *  only these collisions, from the single source of truth for each key. */
function assertNotSweepManaged(featureKey: string | undefined): void {
  if (featureKey !== undefined && SWEEP_MANAGED_FEATURE_KEYS.includes(featureKey)) {
    throw new HttpError(
      400,
      `A size-pack cannot lift '${featureKey}' — that cap is managed by a recurring add-on ` +
        `and would be canceled by its next subscription sync.`,
    );
  }
}

// Size-pack one-time add-on (design/v17-pricing-entitlements/SPEC-2 §3/§11.3,
// v17 Phase 3 Task 3b): a one-time Checkout Session that lifts ONE
// competition's `entrants.per_division.max` by `delta_each`. Unlike the AI
// credit packs (a fixed JSON catalog) the size-pack SHAPE is admin-editable,
// so the catalog is the `size_pack_catalog` DB table (V325); the PRICE stays
// Stripe-owned (stripe-plans.json + stripe:sync), resolved live by lookup_key
// at request time. Built per the `stripe:stripe-best-practices` skill: Checkout
// Sessions for a one-time purchase, `payment_method_types` never sent, the
// billing entity's LOCKED currency (never Adaptive Pricing), and an
// `integration_identifier` so this flow shows up distinctly in the Dashboard.

/** One catalog row (size_pack_catalog, V325). `feature_key`/`delta_each` are
 *  OUR fields (never sent to Stripe) — the webhook snapshots them into the
 *  org_addons row it grants. `stripe_lookup_key` keys the live price. */
export interface SizePackCatalogRow {
  key: string;
  label: string;
  feature_key: string;
  delta_each: number;
  stripe_lookup_key: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Stable per-integration tag (stripe skill: `integration_identifier`, API
 *  2026-03-25.dahlia+) — NOT per-session/random. Marks this checkout surface
 *  distinctly in the Dashboard; the 8-letter suffix is the skill's convention
 *  for keeping integration labels unique. */
const INTEGRATION_IDENTIFIER = "seazn_size_pack_qkbrmxtl";

/** One catalog row by key, or null when absent. */
export async function getSizePack(key: string): Promise<SizePackCatalogRow | null> {
  const [row] = await sql<SizePackCatalogRow[]>`
    select key, label, feature_key, delta_each, stripe_lookup_key, active, created_at, updated_at
      from size_pack_catalog where key = ${key}`;
  return row ?? null;
}

/** The catalog. `activeOnly` filters to buyable packs (what a buy UI lists);
 *  the staff CRUD lists everything. */
export async function listSizePacks(opts: { activeOnly?: boolean } = {}): Promise<SizePackCatalogRow[]> {
  if (opts.activeOnly) {
    return sql<SizePackCatalogRow[]>`
      select key, label, feature_key, delta_each, stripe_lookup_key, active, created_at, updated_at
        from size_pack_catalog where active = true order by created_at`;
  }
  return sql<SizePackCatalogRow[]>`
    select key, label, feature_key, delta_each, stripe_lookup_key, active, created_at, updated_at
      from size_pack_catalog order by created_at`;
}

/** Create a catalog row (staff CRUD). */
export async function createSizePack(
  input: {
    key: string;
    label: string;
    feature_key: string;
    delta_each: number;
    stripe_lookup_key: string;
    active?: boolean;
  },
  exec: Exec = sql,
): Promise<SizePackCatalogRow> {
  assertNotSweepManaged(input.feature_key);
  const [row] = await exec<SizePackCatalogRow[]>`
    insert into size_pack_catalog (key, label, feature_key, delta_each, stripe_lookup_key, active)
    values (${input.key}, ${input.label}, ${input.feature_key}, ${input.delta_each},
            ${input.stripe_lookup_key}, ${input.active ?? true})
    returning key, label, feature_key, delta_each, stripe_lookup_key, active, created_at, updated_at`;
  return row!;
}

/** Edit a catalog row's SHAPE (never its price — that is Stripe-owned). Only
 *  the fields provided are changed. A size-pack already GRANTED into org_addons
 *  is a frozen row (the webhook snapshotted its feature_key/delta_each at grant
 *  time), so an edit here never retroactively changes a purchased pack. */
export async function updateSizePack(
  key: string,
  patch: Partial<{
    label: string;
    feature_key: string;
    delta_each: number;
    stripe_lookup_key: string;
    active: boolean;
  }>,
  exec: Exec = sql,
): Promise<SizePackCatalogRow | null> {
  assertNotSweepManaged(patch.feature_key);
  const [row] = await exec<SizePackCatalogRow[]>`
    update size_pack_catalog set
      label             = coalesce(${patch.label ?? null}, label),
      feature_key       = coalesce(${patch.feature_key ?? null}, feature_key),
      delta_each        = coalesce(${patch.delta_each ?? null}, delta_each),
      stripe_lookup_key = coalesce(${patch.stripe_lookup_key ?? null}, stripe_lookup_key),
      active            = coalesce(${patch.active ?? null}, active),
      updated_at        = now()
    where key = ${key}
    returning key, label, feature_key, delta_each, stripe_lookup_key, active, created_at, updated_at`;
  return row ?? null;
}

/** Soft-deactivate a catalog row (prefer this over DELETE — never orphan a
 *  purchased pack's catalog reference). A deactivated pack cannot be bought,
 *  but already-granted packs are unaffected (frozen org_addons rows). */
export async function setSizePackActive(
  key: string,
  active: boolean,
  exec: Exec = sql,
): Promise<SizePackCatalogRow | null> {
  return updateSizePack(key, { active }, exec);
}

/**
 * The live Stripe price id for a size pack, resolved by `lookup_key` at request
 * time (mirrors `resolveCreditPackPriceId`) — there is no `plans` row for a
 * size pack, and `stripe.prices.list` by lookup_key is exactly Stripe's
 * recommendation. 503s when `stripe:sync` has not yet been run for this SKU.
 */
export async function resolveSizePackPriceId(lookupKey: string): Promise<string> {
  const found = await getStripe().prices.list({ lookup_keys: [lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  }
  return price.id;
}

/**
 * Params for a one-time size-pack Checkout Session. Pure (no Stripe/DB calls),
 * mirroring `buildCreditPackCheckoutParams`. `metadata` SNAPSHOTS `feature_key`
 * + `delta_each` at checkout creation (T1 lesson): the webhook grants exactly
 * what was sold, independent of any later catalog edit. `target_org_id` +
 * `target_competition_id` tell the webhook which org's wallet and which
 * competition the cap-lift is scoped to.
 */
export function buildSizePackCheckoutParams(args: {
  priceId: string;
  sizePackKey: string;
  targetOrgId: string;
  targetCompetitionId: string;
  featureKey: string;
  deltaEach: number;
  competitionName: string;
  returnUrl: string;
  customerId?: string;
  customerEmail?: string;
  /** The billing entity's LOCKED currency (SPEC-2 §6): Stripe forbids mixing
   *  currencies on one customer, so this must be what `preferredCurrency`
   *  already resolved, never a fresh guess. */
  currency?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    ui_mode: "embedded_page",
    mode: "payment",
    ...(args.customerId
      ? { customer: args.customerId, ...CUSTOMER_UPDATE_FOR_TAX }
      : { customer_email: args.customerEmail }),
    invoice_creation: {
      enabled: true,
      invoice_data: { description: `Size pack — ${args.competitionName}` },
    },
    currency: args.currency ?? "usd",
    // Adaptive Pricing re-quotes at render time from the buyer's IP unless
    // explicitly disabled — we quote one currency, we must charge it.
    adaptive_pricing: { enabled: false },
    metadata: {
      kind: "size_pack",
      size_pack_key: args.sizePackKey,
      target_org_id: args.targetOrgId,
      target_competition_id: args.targetCompetitionId,
      feature_key: args.featureKey,
      delta_each: String(args.deltaEach),
    },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    branding_settings: { ...CHECKOUT_BRANDING },
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
}

// Sync Stripe products/prices from apps/web/src/config/stripe-plans.json into
// Stripe + the `plans` table. Idempotent: a price is matched by its stable
// `lookup_key`, so re-running never duplicates. Stripe price amounts AND the
// pricing structure itself (per_unit vs tiered) are immutable, so when the JSON
// drifts from the live price the script mints a REPLACEMENT price (carrying the
// lookup_key via transfer_lookup_key) and archives the old one — that is the
// sanctioned way to roll out a price change. Existing subscriptions keep their
// original price id (Task 8 sync guards), so no one is repriced mid-term.
//
// Billing groups: a paid subscription covers a GROUP of organisations, and the
// subscription's `quantity` is the number of orgs in it. Those plans are priced
// with graduated tiers — tier 1 is the base rate, tier 2+ is an extra org at
// half — so this script sends billing_scheme/tiers_mode/tiers when the seed has
// them. Flat prices (the one-time Event Pass) keep the plain unit_amount shape.
//
// Run after db:apply / any wipe, once per environment (test/prod) by pointing at it:
//   node --env-file=apps/web/.env.local --experimental-strip-types scripts/stripe-sync.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import Stripe from "stripe";

/** One graduated tier. `up_to: "inf"` is the fallback tier (Stripe's own token);
 *  `currency_options` are SET per-currency amounts for THIS tier, never FX. */
export interface TierSpec {
  up_to: number | "inf";
  unit_amount: number;
  currency_options?: Record<string, number>;
}
export interface PriceSpec {
  lookup_key: string;
  /** Tier-1 amount. On a tiered price this is NOT sent to Stripe — it is what a
   *  group of one pays, and what the pricing page / lib/currency.ts advertise. */
  unit_amount: number;
  interval?: "month" | "year";
  /** SET per-currency price points (v3/07 §4), minor units. Same tier-1 caveat. */
  currency_options?: Record<string, number>;
  billing_scheme?: "per_unit" | "tiered";
  tiers_mode?: "graduated" | "volume";
  tiers?: TierSpec[];
}
export interface PlanSpec {
  key: string;
  product: { name: string; description?: string };
  prices: { monthly: PriceSpec; annual: PriceSpec };
}
export interface PassSpec {
  key: string;
  product: { name: string; description?: string };
  price: PriceSpec;
}
/** A one-time AI credit pack (v17 SPEC-2 §5/§6). Structurally identical to a
 *  PassSpec — one product, one flat price — plus `credits`, which is never
 *  sent to Stripe: it is the ledger delta the webhook grants. The webhook grants
 *  the `credits` snapshot stamped into session metadata at checkout creation;
 *  this seed is only the logged fallback (staff-alerted on drift). */
export interface PackSpec {
  key: string;
  credits: number;
  product: { name: string; description?: string };
  price: PriceSpec;
}
/** The extra-seat RECURRING add-on (v17 SPEC-2 §3/§11.3). Like a PassSpec/PackSpec
 *  it is one product + one price, but its price carries an `interval` (recurring,
 *  not one-time) and it lifts a cap: `feature_key`/`delta_each` are OUR fields
 *  (never sent to Stripe) — the webhook grants a `feature_key` add-on of
 *  `delta_each` per seat. No `plans` row: the seat usecase resolves the live
 *  price by lookup_key at request time, so this only ensures the price exists. */
export interface SeatSpec {
  key: string;
  feature_key: string;
  delta_each: number;
  product: { name: string; description?: string };
  price: PriceSpec;
}
/** The size-pack ONE-TIME add-on (v17 SPEC-2 §3/§11.3, Phase 3 Task 3b).
 *  Structurally like a SeatSpec — one product, one price, `feature_key`/
 *  `delta_each` that are OUR fields (never sent to Stripe) — but its price is
 *  ONE-TIME (no `interval`, so priceCreateParams omits `recurring`), because a
 *  competition is a bounded event, not a subscription. No `plans` row: the
 *  checkout resolves the live price by lookup_key at request time. */
export interface SizePackSpec {
  key: string;
  feature_key: string;
  delta_each: number;
  product: { name: string; description?: string };
  price: PriceSpec;
}
/** The extra-org RECURRING add-on (v17 gap #293). Structurally identical to a
 *  SeatSpec — one product, one recurring price, `feature_key`/`delta_each`
 *  OUR fields never sent to Stripe — but ONE ENTRY PER PLAN (`plan_key`)
 *  because the rate differs by tier ($9 Pro / $19 Pro Plus). No `plans` row:
 *  lib/org-addons.ts resolves the live price by lookup_key at request time. */
export interface OrgAddonSpec {
  key: string;
  plan_key: string;
  feature_key: string;
  delta_each: number;
  product: { name: string; description?: string };
  price: PriceSpec;
}
export interface Seed {
  currency: string;
  plans: PlanSpec[];
  passes?: PassSpec[];
  packs?: PackSpec[];
  seats?: SeatSpec[];
  size_packs?: SizePackSpec[];
  org_addons?: OrgAddonSpec[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(__dirname, "..", "apps", "web", "src", "config", "stripe-plans.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Seed;

/** A spec is tiered when it declares BOTH `billing_scheme: "tiered"` and a ladder.
 *  Half-declared FAILS CLOSED: dropping either half would otherwise fall through
 *  to the flat path and mint a per_unit price, and per_unit bills quantity × base
 *  — a 2-org Pro group would pay $38 instead of $19 + $9. Refusing to sync is the
 *  cheap failure; a wrong price in Stripe is not. */
export function isTiered(spec: PriceSpec): boolean {
  const hasScheme = spec.billing_scheme === "tiered";
  const hasTiers = !!spec.tiers?.length;
  if (hasScheme !== hasTiers) {
    throw new Error(
      `${spec.lookup_key}: half-declared tiered price — ` +
        `billing_scheme=${spec.billing_scheme ?? "(unset)"} but ${hasTiers ? "tiers are present" : "tiers are missing"}. ` +
        `Set both or neither; a flat price here would bill every extra organisation at full rate.`,
    );
  }
  return hasScheme;
}

/** The non-base currencies every price must SET a point in — the same list
 *  lib/currency.ts advertises minus the seed's base currency (usd, which is the
 *  price's own `unit_amount`). Pinned to SUPPORTED_CURRENCIES by
 *  stripe-sync.test.ts; kept as a literal here because scripts/ is compiled by
 *  tsconfig.scripts.json and does not resolve apps/web's `@/` alias. */
export const REQUIRED_CURRENCIES = ["eur", "gbp", "inr", "aud"] as const;

/** Every price must price every currency. A hole does NOT fail at sync time —
 *  Stripe accepts the price and falls back to ADAPTIVE PRICING, an FX-converted
 *  amount decided at render time from the buyer's IP — which is precisely what
 *  this seed's SET price points (v3/07 §4) exist to avoid. Refusing to sync is
 *  the cheap failure; a silently FX-priced SKU in production is not. */
function assertCurrencyCoverage(lookupKey: string, present: readonly string[]): void {
  const missing = REQUIRED_CURRENCIES.filter((c) => !present.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `${lookupKey}: no price point for ${missing.join(", ")}. ` +
        `Every price must SET all of ${REQUIRED_CURRENCIES.join(", ")} — a missing one does not ` +
        `fail in Stripe, it silently falls back to adaptive (FX) pricing.`,
    );
  }
}

export function currencyOptionsParam(
  spec: PriceSpec,
): Record<string, { unit_amount: number }> | undefined {
  assertCurrencyCoverage(spec.lookup_key, Object.keys(spec.currency_options ?? {}));
  return Object.fromEntries(
    Object.entries(spec.currency_options!).map(([c, amount]) => [c, { unit_amount: amount }]),
  );
}

/** Transpose the seed's per-TIER currency amounts into Stripe's per-CURRENCY tier
 *  ladders. The seed nests currencies inside tiers (readable: one row per tier);
 *  Stripe's API is the other way round — `currency_options[eur].tiers[]` — and
 *  rejects `currency_options` inside a tier. Every tier must price every currency:
 *  a currency's ladder has to mirror the default ladder 1:1, and a hole in it
 *  would make Stripe bill an unexpected amount rather than fail, so we throw. */
export function tieredCurrencyOptionsParam(
  spec: PriceSpec,
): Record<string, { tiers: Stripe.PriceCreateParams.CurrencyOptions.Tier[] }> | undefined {
  const tiers = spec.tiers ?? [];
  const currencies = [...new Set(tiers.flatMap((t) => Object.keys(t.currency_options ?? {})))];
  // A ladder where EVERY tier agrees on three currencies is self-consistent, so
  // the per-tier check below can never see the fourth missing — only the
  // required-set check can.
  assertCurrencyCoverage(spec.lookup_key, currencies);
  return Object.fromEntries(
    currencies.map((currency) => [
      currency,
      {
        tiers: tiers.map((t, i) => {
          const amount = t.currency_options?.[currency];
          if (amount === undefined) {
            throw new Error(
              `${spec.lookup_key}: tier ${i + 1} is missing a ${currency} amount; ` +
                `every tier must set every currency or Stripe bills the wrong ladder.`,
            );
          }
          return { up_to: t.up_to, unit_amount: amount };
        }),
      },
    ]),
  );
}

/** The exact Stripe create payload for a spec. Pure + exported so tests can assert
 *  the shape without touching the API. Tiered prices must NOT carry a top-level
 *  `unit_amount` (Stripe: "unless billing_scheme=tiered") nor flat
 *  `currency_options.unit_amount` — the seed keeps both for the pricing page. */
export function priceCreateParams(
  spec: PriceSpec,
  productId: string,
  currency: string,
  planKey: string,
): Stripe.PriceCreateParams {
  const recurring = spec.interval ? { recurring: { interval: spec.interval } } : {};
  const common = {
    product: productId,
    currency,
    ...recurring,
    lookup_key: spec.lookup_key,
    transfer_lookup_key: true,
    metadata: { seazn_plan: planKey },
  } satisfies Partial<Stripe.PriceCreateParams>;

  if (isTiered(spec)) {
    const options = tieredCurrencyOptionsParam(spec);
    return {
      ...common,
      billing_scheme: "tiered",
      tiers_mode: spec.tiers_mode ?? "graduated",
      tiers: (spec.tiers ?? []).map((t) => ({
        up_to: t.up_to,
        unit_amount: t.unit_amount,
      })),
      ...(options ? { currency_options: options } : {}),
    };
  }
  const options = currencyOptionsParam(spec);
  return {
    ...common,
    unit_amount: spec.unit_amount,
    ...(options ? { currency_options: options } : {}),
  };
}

/** Stripe returns `up_to: null` for the fallback tier; the seed writes "inf". */
function sameUpTo(live: number | null, wanted: number | "inf"): boolean {
  return wanted === "inf" ? live === null : live === wanted;
}

/** Compare a live tier ladder against the seed's. `live === undefined` means the
 *  list call did not expand tiers — we cannot tell, and reporting drift there
 *  would mint a brand-new price on EVERY run, so callers treat it as "no drift"
 *  and warn instead. */
function tiersDiffer(
  live: Array<{ up_to: number | null; unit_amount: number | null }>,
  wanted: TierSpec[],
  amount: (t: TierSpec) => number | undefined,
): boolean {
  if (live.length !== wanted.length) return true;
  return wanted.some(
    (t, i) => !sameUpTo(live[i]!.up_to, t.up_to) || live[i]!.unit_amount !== amount(t),
  );
}

/** True when a live Stripe price no longer matches the seed. For flat specs that
 *  is the base `unit_amount` plus each per-currency amount; for tiered specs it is
 *  the billing scheme, tiers_mode, the tier count, every tier's `up_to` and
 *  `unit_amount`, and every per-currency tier ladder. A scheme change (flat →
 *  tiered) counts as drift — Stripe cannot convert a price in place, so it too
 *  has to go through the replace-and-archive path below.
 *  Requires the price to have been fetched with `tiers` + `currency_options`
 *  expanded, else those fields are absent and drift is invisible. */
export function priceHasDrifted(existing: Stripe.Price, spec: PriceSpec): boolean {
  const have = existing.currency_options ?? {};

  if (isTiered(spec)) {
    // A per_unit price can never become tiered — that is a replacement, not drift
    // in the amount sense, but the same remedy applies.
    if (existing.billing_scheme !== "tiered") return true;
    if (existing.tiers_mode !== (spec.tiers_mode ?? "graduated")) return true;
    if (!existing.tiers) {
      console.warn(
        `  ! ${spec.lookup_key}: live price is tiered but tiers were not expanded — ` +
          `skipping tier drift check (assuming unchanged) rather than reminting every run.`,
      );
      return false;
    }
    if (tiersDiffer(existing.tiers, spec.tiers!, (t) => t.unit_amount)) return true;
    // tieredCurrencyOptionsParam throws on a tier that skips a currency, so
    // reaching here means every currency below is priced in every tier.
    for (const currency of Object.keys(tieredCurrencyOptionsParam(spec) ?? {})) {
      const liveOption = have[currency];
      if (!liveOption) return true; // currency point missing entirely
      if (!liveOption.tiers) {
        console.warn(
          `  ! ${spec.lookup_key}: ${currency} tiers were not expanded — skipping its drift check.`,
        );
        continue;
      }
      if (tiersDiffer(liveOption.tiers, spec.tiers!, (t) => t.currency_options?.[currency])) {
        return true;
      }
    }
    return false;
  }

  // Flat spec. A live price that somehow became tiered is drift in the other
  // direction (unit_amount is null on tiered prices, so the compare below would
  // catch it anyway — this is explicit for the reader).
  if (existing.billing_scheme === "tiered") return true;
  if (existing.unit_amount !== spec.unit_amount) return true;
  const wanted = spec.currency_options ?? {};
  for (const [currency, amount] of Object.entries(wanted)) {
    if (have[currency]?.unit_amount !== amount) return true;
  }
  return false;
}

/** Create a fresh Stripe price carrying the seed's lookup_key. `transfer_lookup_key`
 *  moves the key off any existing price so the checkout route keeps resolving it. */
async function createPrice(
  stripe: Stripe,
  spec: PriceSpec,
  productId: string,
  currency: string,
  planKey: string,
): Promise<string> {
  const price = await stripe.prices.create(priceCreateParams(spec, productId, currency, planKey));
  return price.id;
}

/** The currencies whose TIER ladders have to be expanded to see drift — none on
 *  a flat price, whose per-currency amounts come back with `currency_options`. */
function tierCurrencies(spec: PriceSpec): string[] {
  return isTiered(spec) ? Object.keys(tieredCurrencyOptionsParam(spec) ?? {}) : [];
}

/** The live product behind a price, but only when the response actually carries
 *  its copy: `ensurePrice` expands `data.product`, so this is normally the whole
 *  object — a bare id (unexpanded response) or a deleted product has no
 *  name/description to compare the seed against, and writing to either blind
 *  would rewrite every product on every run. */
function liveProductCopy(
  product: Stripe.Price["product"],
): { name: string; description: string } | null {
  if (typeof product === "string") return null;
  if ((product as Stripe.DeletedProduct).deleted === true) return null;
  const live = product as Stripe.Product;
  return { name: live.name, description: live.description ?? "" };
}

/** Find a price by lookup_key; if any amount OR the tier structure drifted, mint a
 *  replacement and archive the old price; else create it (and a product if needed).
 *  Product name/description are synced separately — they are mutable, so they
 *  never need a replacement price. Omitting `interval` makes it one-time. */
export async function ensurePrice(
  stripe: Stripe,
  spec: PriceSpec,
  product: { name: string; description?: string },
  planKey: string,
  currency: string,
  productId: string | null,
): Promise<{ priceId: string; productId: string }> {
  const found = await stripe.prices.list({
    lookup_keys: [spec.lookup_key],
    limit: 1,
    // `tiers` and `currency_options` are both omitted from the default response;
    // without them priceHasDrifted is blind to every tiered amount. The ladder
    // INSIDE each currency option needs its own expand, and only the
    // per-currency form works: `data.currency_options.tiers` is accepted and
    // silently ignored by the API (verified against a live account, v17 #293).
    // Without these the sync logged "! <price>: <currency> tiers were not
    // expanded — skipping its drift check" for every currency of every tiered
    // price, so a changed eur/gbp/inr/aud tier amount was never re-minted.
    expand: [
      "data.product",
      "data.currency_options",
      "data.tiers",
      ...tierCurrencies(spec).map((c) => `data.currency_options.${c}.tiers`),
    ],
  });
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
    // Product name/description are MUTABLE, unlike every price field below, and
    // they are the part of the seed a BUYER reads — Checkout renders the
    // product's name and description on the payment page. So sync them here, on
    // every run, independent of whether the price drifted: without this a
    // copy-only stripe-plans.json edit (a corrected claim, say) reached Stripe
    // never, because the matched-price path returned a few lines down and
    // `products.create` — the script's only other Products call — fires solely
    // when no price exists at all.
    const live = liveProductCopy(p.product);
    // Stripe unsets a string field with the EMPTY STRING: `description:
    // undefined` is dropped from the request body, leaves the stale copy live,
    // and would re-fire this same update on every subsequent run.
    const wantDescription = product.description ?? "";
    if (live && (live.name !== product.name || live.description !== wantDescription)) {
      await stripe.products.update(prod, { name: product.name, description: wantDescription });
      console.log(`  ↳ ${spec.lookup_key}: product copy updated (${prod})`);
    }
    // The base currency is immutable too, and a price minted under the wrong one
    // charges every group in the wrong money — cheap to check here, where the
    // seed's currency is in scope (priceHasDrifted only sees the spec).
    const currencyDrift = p.currency !== currency;
    if (currencyDrift) {
      console.warn(`  ! ${spec.lookup_key}: live currency ${p.currency} ≠ seed ${currency}`);
    }
    if (!currencyDrift && !priceHasDrifted(p, spec)) return { priceId: p.id, productId: prod };
    // Stripe prices are immutable — amounts AND billing_scheme alike, so a flat
    // price can never be "upgraded" to tiered by update. Create a replacement
    // carrying the lookup_key (transfer_lookup_key moves it off the old price),
    // then archive the old price so nothing new resolves to it. Existing
    // subscriptions keep their original price id (Task 8 sync guards) — no one is
    // repriced mid-term, but note that also means groups on the old flat price
    // stay flat until they are explicitly migrated.
    const replacementId = await createPrice(stripe, spec, prod, currency, planKey);
    await stripe.prices.update(p.id, { active: false });
    console.log(`  ↳ ${spec.lookup_key}: drift → new price ${replacementId} (archived ${p.id})`);
    return { priceId: replacementId, productId: prod };
  }
  const prod =
    productId ??
    (
      await stripe.products.create({
        name: product.name,
        description: product.description,
        metadata: { seazn_plan: planKey },
      })
    ).id;
  const priceId = await createPrice(stripe, spec, prod, currency, planKey);
  return { priceId, productId: prod };
}

/** Write resolved price ids onto the plans row (the checkout route reads these). */
export async function applyPlanPrices(
  db: postgres.Sql,
  planKey: string,
  prices: { monthly: string; annual: string },
): Promise<void> {
  await db`
    update plans
    set stripe_price_id_monthly = ${prices.monthly},
        stripe_price_id_annual  = ${prices.annual}
    where key = ${planKey}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }
  console.log(`Stripe mode: ${key.includes("_test_") ? "TEST" : "LIVE"}`);

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  const stripe = new Stripe(key);

  try {
    for (const plan of seed.plans) {
      let productId: string | null = null;
      const monthly = await ensurePrice(
        stripe,
        plan.prices.monthly,
        plan.product,
        plan.key,
        seed.currency,
        productId,
      );
      productId = monthly.productId;
      const annual = await ensurePrice(
        stripe,
        plan.prices.annual,
        plan.product,
        plan.key,
        seed.currency,
        productId,
      );
      await applyPlanPrices(sql, plan.key, {
        monthly: monthly.priceId,
        annual: annual.priceId,
      });
      console.log(`✓ ${plan.key}: monthly=${monthly.priceId} annual=${annual.priceId}`);
    }
    // One-time passes (v3/07 §3): same lookup_key idempotency, price id lands in
    // plans.stripe_price_id_onetime for the pass-checkout route. Passes are flat
    // (tiered pricing is recurring-only in Stripe), so they take the unit_amount path.
    for (const pass of seed.passes ?? []) {
      const price = await ensurePrice(
        stripe,
        pass.price,
        pass.product,
        pass.key,
        seed.currency,
        null,
      );
      await sql`
        update plans set stripe_price_id_onetime = ${price.priceId} where key = ${pass.key}`;
      console.log(`✓ ${pass.key}: onetime=${price.priceId}`);
    }
    // AI credit packs (v17 Phase 3 Task 1): same idempotent ensurePrice, but no
    // `plans` row to write back to — createCreditPackCheckout (lib/credit-packs.ts)
    // resolves the live price by lookup_key at request time instead.
    for (const pack of seed.packs ?? []) {
      const price = await ensurePrice(stripe, pack.price, pack.product, pack.key, seed.currency, null);
      console.log(`✓ ${pack.key}: onetime=${price.priceId} (${pack.credits} credits)`);
    }
    // Extra-seat recurring add-on (v17 Phase 3 Task 3a): same idempotent
    // ensurePrice as a plan, but no `plans` row to write back to — the seat
    // usecase (lib/seat-addons.resolveSeatPriceId) resolves the live price by
    // lookup_key at request time. The price's `interval` makes it RECURRING
    // (priceCreateParams sends `recurring`), unlike the one-time packs above.
    for (const seat of seed.seats ?? []) {
      const price = await ensurePrice(stripe, seat.price, seat.product, seat.key, seed.currency, null);
      console.log(
        `✓ ${seat.key}: recurring=${price.priceId} (${seat.feature_key} +${seat.delta_each}/seat)`,
      );
    }
    // Size-pack ONE-TIME add-on (v17 Phase 3 Task 3b): idempotent ensurePrice
    // like the packs (no `interval` → one-time), no `plans` row to write back —
    // createSizePackCheckout (lib/size-packs.resolveSizePackPriceId) resolves the
    // live price by lookup_key at request time. The pack SHAPE is DB-configurable
    // (size_pack_catalog, V325); only the PRICE is Stripe-owned and synced here.
    for (const sizePack of seed.size_packs ?? []) {
      const price = await ensurePrice(
        stripe,
        sizePack.price,
        sizePack.product,
        sizePack.key,
        seed.currency,
        null,
      );
      console.log(
        `✓ ${sizePack.key}: onetime=${price.priceId} (${sizePack.feature_key} +${sizePack.delta_each})`,
      );
    }
    // Extra-org RECURRING add-on (v17 gap #293): same idempotent ensurePrice as
    // a seat (the price's `interval` makes it recurring), but ONE PRICE PER
    // PLAN because the rate differs by tier — lib/org-addons.
    // resolveOrgAddonPriceId(planKey) resolves the plan-specific live price by
    // lookup_key at request time, so there is no `plans` row to write back to.
    for (const orgAddon of seed.org_addons ?? []) {
      const price = await ensurePrice(
        stripe,
        orgAddon.price,
        orgAddon.product,
        orgAddon.key,
        seed.currency,
        null,
      );
      console.log(
        `✓ ${orgAddon.key}: recurring=${price.priceId} ` +
          `(${orgAddon.plan_key}, ${orgAddon.feature_key} +${orgAddon.delta_each}/org)`,
      );
    }
    console.log("Stripe sync complete.");
  } finally {
    await sql.end();
  }
}

// Only run when invoked as a script — the pure helpers above are imported by
// tests, which must never open a DB connection or touch the Stripe API.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

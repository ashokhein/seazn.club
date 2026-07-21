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
export interface Seed {
  currency: string;
  plans: PlanSpec[];
  passes?: PassSpec[];
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

function currencyOptionsParam(
  spec: PriceSpec,
): Record<string, { unit_amount: number }> | undefined {
  if (!spec.currency_options) return undefined;
  return Object.fromEntries(
    Object.entries(spec.currency_options).map(([c, amount]) => [c, { unit_amount: amount }]),
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
  if (currencies.length === 0) return undefined;
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

/** Find a price by lookup_key; if any amount OR the tier structure drifted, mint a
 *  replacement and archive the old price; else create it (and a product if needed).
 *  Omitting `interval` makes it one-time. */
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
    // without them priceHasDrifted is blind to every tiered amount.
    expand: ["data.product", "data.currency_options", "data.tiers"],
  });
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
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

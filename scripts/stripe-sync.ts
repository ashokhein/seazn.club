// Sync Stripe products/prices from apps/web/src/config/stripe-plans.json into
// Stripe + the `plans` table. Idempotent: a price is matched by its stable
// `lookup_key`, so re-running never duplicates. Stripe price amounts are
// immutable, so when the JSON's unit_amount or any currency_options amount
// drifts from the live price, the script mints a REPLACEMENT price (carrying the
// lookup_key via transfer_lookup_key) and archives the old one — that is the
// sanctioned way to roll out a price change. Existing subscriptions keep their
// original price id (Task 8 sync guards), so no one is repriced mid-term. Run
// after db:apply / any wipe, once per environment (test/prod) by pointing at it:
//   node --env-file=apps/web/.env.local --experimental-strip-types scripts/stripe-sync.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import Stripe from "stripe";

interface PriceSpec {
  lookup_key: string;
  unit_amount: number;
  interval?: "month" | "year";
  /** SET per-currency price points (v3/07 §4), minor units. */
  currency_options?: Record<string, number>;
}
interface PlanSpec {
  key: string;
  product: { name: string; description?: string };
  prices: { monthly: PriceSpec; annual: PriceSpec };
}
interface PassSpec {
  key: string;
  product: { name: string; description?: string };
  price: PriceSpec;
}
interface Seed { currency: string; plans: PlanSpec[]; passes?: PassSpec[] }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(__dirname, "..", "apps", "web", "src", "config", "stripe-plans.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Seed;

const url = process.env.DATABASE_URL;
const key = process.env.STRIPE_SECRET_KEY;
if (!url) { console.error("DATABASE_URL is not set."); process.exit(1); }
if (!key) { console.error("STRIPE_SECRET_KEY is not set."); process.exit(1); }
console.log(`Stripe mode: ${key.includes("_test_") ? "TEST" : "LIVE"}`);

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});
const stripe = new Stripe(key);

function currencyOptionsParam(
  spec: PriceSpec,
): Record<string, { unit_amount: number }> | undefined {
  if (!spec.currency_options) return undefined;
  return Object.fromEntries(
    Object.entries(spec.currency_options).map(([c, amount]) => [c, { unit_amount: amount }]),
  );
}

/** True when a live Stripe price no longer matches the seed's amounts. Both the
 *  base `unit_amount` AND each per-currency `currency_options` amount are checked.
 *  Stripe price amounts are immutable, so ANY drift forces a replacement price
 *  (not an in-place update). Requires the price to have been fetched with
 *  currency_options expanded, else `existing.currency_options` is null. */
export function priceHasDrifted(existing: Stripe.Price, spec: PriceSpec): boolean {
  if (existing.unit_amount !== spec.unit_amount) return true;
  const wanted = spec.currency_options ?? {};
  const have = existing.currency_options ?? {};
  for (const [currency, amount] of Object.entries(wanted)) {
    if (have[currency]?.unit_amount !== amount) return true;
  }
  return false;
}

/** Create a fresh Stripe price carrying the seed's lookup_key. `transfer_lookup_key`
 *  moves the key off any existing price so the checkout route keeps resolving it. */
async function createPrice(
  spec: PriceSpec,
  productId: string,
  currency: string,
  planKey: string,
): Promise<string> {
  const options = currencyOptionsParam(spec);
  const price = await stripe.prices.create({
    product: productId,
    currency,
    unit_amount: spec.unit_amount,
    ...(spec.interval ? { recurring: { interval: spec.interval } } : {}),
    ...(options ? { currency_options: options } : {}),
    lookup_key: spec.lookup_key,
    transfer_lookup_key: true,
    metadata: { seazn_plan: planKey },
  });
  return price.id;
}

/** Find a price by lookup_key; if any amount drifted, mint a replacement and
 *  archive the old price; else create it (and a product if needed). Omitting
 *  `interval` makes it one-time. */
async function ensurePrice(
  spec: PriceSpec,
  product: { name: string; description?: string },
  planKey: string,
  currency: string,
  productId: string | null,
): Promise<{ priceId: string; productId: string }> {
  const found = await stripe.prices.list({
    lookup_keys: [spec.lookup_key],
    limit: 1,
    expand: ["data.product", "data.currency_options"],
  });
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
    if (!priceHasDrifted(p, spec)) return { priceId: p.id, productId: prod };
    // Stripe price amounts are immutable: create a replacement carrying the
    // lookup_key (transfer_lookup_key moves it off the old price), then archive
    // the old price so nothing new resolves to it. Existing subscriptions keep
    // their original price id (Task 8 sync guards) — no one is repriced mid-term.
    const replacementId = await createPrice(spec, prod, currency, planKey);
    await stripe.prices.update(p.id, { active: false });
    console.log(`  ↳ ${spec.lookup_key}: amount drift → new price ${replacementId} (archived ${p.id})`);
    return { priceId: replacementId, productId: prod };
  }
  const prod =
    productId ??
    (await stripe.products.create({
      name: product.name,
      description: product.description,
      metadata: { seazn_plan: planKey },
    })).id;
  const priceId = await createPrice(spec, prod, currency, planKey);
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

try {
  for (const plan of seed.plans) {
    let productId: string | null = null;
    const monthly = await ensurePrice(plan.prices.monthly, plan.product, plan.key, seed.currency, productId);
    productId = monthly.productId;
    const annual = await ensurePrice(plan.prices.annual, plan.product, plan.key, seed.currency, productId);
    await applyPlanPrices(sql, plan.key, { monthly: monthly.priceId, annual: annual.priceId });
    console.log(`✓ ${plan.key}: monthly=${monthly.priceId} annual=${annual.priceId}`);
  }
  // One-time passes (v3/07 §3): same lookup_key idempotency, price id lands in
  // plans.stripe_price_id_onetime for the pass-checkout route.
  for (const pass of seed.passes ?? []) {
    const price = await ensurePrice(pass.price, pass.product, pass.key, seed.currency, null);
    await sql`
      update plans set stripe_price_id_onetime = ${price.priceId} where key = ${pass.key}`;
    console.log(`✓ ${pass.key}: onetime=${price.priceId}`);
  }
  console.log("Stripe sync complete.");
} finally {
  await sql.end();
}

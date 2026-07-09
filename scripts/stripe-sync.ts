// Sync Stripe products/prices from apps/web/src/config/stripe-plans.json into
// Stripe + the `plans` table. Idempotent: a price is matched by its stable
// `lookup_key`, so re-running never duplicates. Run after db:apply / any wipe,
// once per environment (test/prod) by pointing the env at it:
//   node --env-file=apps/web/.env.local --experimental-strip-types scripts/stripe-sync.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import Stripe from "stripe";

interface PriceSpec { lookup_key: string; unit_amount: number; interval: "month" | "year" }
interface PlanSpec {
  key: string;
  product: { name: string; description?: string };
  prices: { monthly: PriceSpec; annual: PriceSpec };
}
interface Seed { currency: string; plans: PlanSpec[] }

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

/** Find a price by lookup_key, else create it (and a product if needed). */
async function ensurePrice(spec: PriceSpec, plan: PlanSpec, currency: string, productId: string | null): Promise<{ priceId: string; productId: string }> {
  const found = await stripe.prices.list({ lookup_keys: [spec.lookup_key], limit: 1, expand: ["data.product"] });
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
    return { priceId: p.id, productId: prod };
  }
  const prod =
    productId ??
    (await stripe.products.create({
      name: plan.product.name,
      description: plan.product.description,
      metadata: { seazn_plan: plan.key },
    })).id;
  const price = await stripe.prices.create({
    product: prod,
    currency,
    unit_amount: spec.unit_amount,
    recurring: { interval: spec.interval },
    lookup_key: spec.lookup_key,
    transfer_lookup_key: true,
    metadata: { seazn_plan: plan.key },
  });
  return { priceId: price.id, productId: prod };
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
    const monthly = await ensurePrice(plan.prices.monthly, plan, seed.currency, productId);
    productId = monthly.productId;
    const annual = await ensurePrice(plan.prices.annual, plan, seed.currency, productId);
    await applyPlanPrices(sql, plan.key, { monthly: monthly.priceId, annual: annual.priceId });
    console.log(`✓ ${plan.key}: monthly=${monthly.priceId} annual=${annual.priceId}`);
  }
  console.log("Stripe sync complete.");
} finally {
  await sql.end();
}

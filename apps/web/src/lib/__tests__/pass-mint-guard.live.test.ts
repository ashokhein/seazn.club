// LIVE verification for the Event Pass mint guard (v17 gap #326) — NOT a unit
// test.
//
// The guard's unit suite (pass-checkout-plan-gate.test.ts) mocks
// `checkout.sessions.listLineItems` with a hand-built `{ data: [{ price: { id }
// }] }`. That fixture is a MODEL of the Stripe response, and the whole guard
// rests on it being the right shape: read the wrong field and the call throws,
// the guard's catch fails OPEN, and it mints every session unverified —
// silently, with the unit suite still green, because the fixture and the reader
// would agree with each other and with nothing else.
//
// So this file asks the real (test-mode) API. It opens an actual Checkout
// Session against a throwaway price and runs the PRODUCTION function over it:
//
//   1. `listLineItems` on a real session id returns exactly one line whose
//      `price.id` is the price the session was built on. (The premise.)
//   2. `passSessionRungMatchesPrice` returns TRUE when the `plans` row names
//      that price — the positive discriminator, without which "refuses
//      everything" would pass.
//   3. ...and FALSE when the row names a different one, which is the desync
//      this guard exists to catch.
//
// Deliberately mints its OWN product + price rather than borrowing the catalog:
// nothing here pins a RATE (that is pass-checkout-l.live.test.ts's job), and a
// probe must never touch a real `seazn_*` lookup key — `transfer_lookup_key`
// MOVES a key and would leave the live catalog price keyless for every other
// task sharing this account. This price carries no lookup_key at all.
//
// Skipped unless BILLING_LIVE=1 AND a TEST-mode Stripe key AND a TEST database.
// Everything created is cleaned up in reverse order of creation; no money moves
// (the session is expired, never paid). Run:
//
//   BILLING_LIVE=1 DATABASE_URL=postgres://postgres@127.0.0.1:54329/seazn_test \
//     DATABASE_SSL=disable DB_SCHEMA=<yours> \
//     npx vitest run --root apps/web --testTimeout=30000 pass-mint-guard.live
//
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { passSessionRungMatchesPrice } from "@/lib/billing";

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const TEST_KEY = KEY.startsWith("sk_test") || KEY.startsWith("rk_test");
// A loud refusal, not a silent skip: this file CREATES a product, a price and a
// checkout session. Asked to run live against a key that is not a test key, the
// only safe answer is to stop the run.
if (process.env.BILLING_LIVE === "1" && KEY && !TEST_KEY) {
  throw new Error(
    "pass-mint-guard.live: BILLING_LIVE=1 with a NON-TEST STRIPE_SECRET_KEY — refusing to run. " +
      "This suite creates real Stripe objects.",
  );
}

// The same refusal for the DATABASE. `!!DATABASE_URL` is not a gate:
// vitest.config.ts loads the repo-root .env.local, whose DATABASE_URL is the DEV
// database with DB_SCHEMA unset — so this file's own documented invocation minus
// its DATABASE_URL line would UPDATE the dev `plans` rows.
const DB = process.env.DATABASE_URL ?? "";
const TEST_DB = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DB) && !!process.env.DB_SCHEMA;
if (process.env.BILLING_LIVE === "1" && DB && !TEST_DB) {
  throw new Error(
    "pass-mint-guard.live: BILLING_LIVE=1 against a database that is not a *_test database with " +
      "an explicit DB_SCHEMA — refusing to run. This suite updates the global `plans` rows.",
  );
}

const LIVE = process.env.BILLING_LIVE === "1" && TEST_KEY && TEST_DB;
const MARKER = `t8a-mint-guard-${randomUUID().slice(0, 8)}`;
// Real uuids: a refusal now WRITES a `pass_mint_refusals` row (V342), whose
// org/competition columns are uuid. Placeholder strings would fail the cast, be
// swallowed by that writer's own catch, and quietly turn the refusal test back
// into an assertion about the return value alone.
const PROBE_ORG = randomUUID();
const PROBE_COMP = randomUUID();

/** LIFO: a price cannot be archived while its product still needs it, and a
 *  product cannot be archived while it has an active price. */
const cleanup: Array<{ what: string; run: () => Promise<unknown> }> = [];

// Constructed in beforeAll, NEVER in the describe body: vitest evaluates the
// factory during collection even under skipIf, so a body-scope constructor
// throws "Neither apiKey nor config.authenticator provided" on every ordinary
// run — a collection failure that reports as a clean skip.
let stripe: Stripe;
let priceId = "";
let sessionId = "";

// The `plans` row this guard reads is GLOBAL to the schema, and
// pass-checkout-plan-gate.test.ts stubs the same one. Captured once and restored
// in afterAll, exactly as that file does; the two would race only in a full
// BILLING_LIVE run, which is a manual act.
let priorOnetime: string | null = null;
let captured = false;

beforeAll(async () => {
  if (!LIVE) return;
  stripe = new Stripe(KEY);

  const product = await stripe.products.create({ name: `${MARKER} probe pass` });
  cleanup.push({
    what: `product ${product.id}`,
    run: () => stripe.products.update(product.id, { active: false }),
  });
  // No lookup_key. See the header: borrowing a `seazn_*` key would move it.
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 2900,
  });
  priceId = price.id;
  cleanup.push({
    what: `price ${price.id}`,
    run: () => stripe.prices.update(price.id, { active: false }),
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    ui_mode: "embedded_page",
    line_items: [{ price: price.id, quantity: 1 }],
    return_url: "https://example.test/return?session_id={CHECKOUT_SESSION_ID}",
    metadata: { marker: MARKER },
  });
  sessionId = session.id;
  cleanup.push({
    what: `session ${session.id}`,
    // Expiring is the strongest disposal a Checkout Session has; it cannot be
    // deleted. It was never paid, so nothing is refunded.
    run: () => stripe.checkout.sessions.expire(session.id),
  });

  const [prior] = await sql<{ id: string | null }[]>`
    select stripe_price_id_onetime as id from plans where key = 'event_pass'`;
  priorOnetime = prior?.id ?? null;
  captured = true;
  // 180s, passed as beforeAll's LAST argument: the hook limit is a SEPARATE 10s
  // default that --testTimeout does not raise, and a blown hook parks every test
  // as pending while the summary still reads "0 failed".
}, 180_000);

afterAll(async () => {
  const stranded: string[] = [];
  for (const { what, run } of cleanup.reverse()) {
    await run().catch((err) => {
      stranded.push(`${what} (${err instanceof Error ? err.message : String(err)})`);
    });
  }
  if (captured) {
    await sql`update plans set stripe_price_id_onetime = ${priorOnetime}
              where key = 'event_pass'`.catch(() => undefined);
  }
  await sql`delete from pass_mint_refusals where competition_id = ${PROBE_COMP}`.catch(
    () => undefined,
  );
  await sql.end({ timeout: 5 }).catch(() => undefined);
  if (stranded.length) {
    console.warn(
      `[pass-mint-guard.live] ${stranded.length} of ${cleanup.length} teardown steps FAILED — ` +
        `stranded in the shared test account:\n  ${stranded.join("\n  ")}`,
    );
  }
}, 180_000);

/** The session as the guard receives it — only `id` and the metadata matter
 *  here; the guard reads the price off Stripe, not off this object. */
const asSession = () =>
  ({
    id: sessionId,
    metadata: { org_id: PROBE_ORG, competition_id: PROBE_COMP, pass_key: "event_pass" },
    payment_status: "paid",
    // Null on purpose: `refusePassMint` must fall back to the session id as the
    // durable key, and that fallback is asserted below.
    payment_intent: null,
  }) as unknown as Stripe.Checkout.Session;

describe.skipIf(!LIVE)("Event Pass mint guard, against the real Stripe API", () => {
  it("reads ONE line item off a real session, and its price.id is the price it was built on", async () => {
    // The premise the whole unit suite's fixture models. If Stripe ever returned
    // the price as a bare string, or nested it differently, the guard's reader
    // would throw and fail OPEN — minting every session unverified with no test
    // anywhere going red.
    const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
    expect(items.data).toHaveLength(1);
    expect(items.data[0]!.price?.id).toBe(priceId);
  });

  it("MINTS when the plans row names the price the session actually carries", async () => {
    // The positive discriminator: without it, a guard that refused everything
    // would pass the negative test below.
    await sql`update plans set stripe_price_id_onetime = ${priceId} where key = 'event_pass'`;
    expect(await passSessionRungMatchesPrice(asSession(), "event_pass", PROBE_ORG)).toBe(true);
  });

  it("REFUSES when the plans row names a different price, and records it durably", async () => {
    await sql`update plans set stripe_price_id_onetime = 'price_not_this_one'
              where key = 'event_pass'`;
    // STAFF_ALERT_EMAIL is left unset by this suite, so the alert wrapper
    // returns before touching an inbox — the refusal and its ROW are what is
    // asserted, and the row is the one that survives a lost email.
    expect(await passSessionRungMatchesPrice(asSession(), "event_pass", PROBE_ORG)).toBe(false);
    const [row] = await sql<{ stripe_ref: string; reason: string; actual_price_id: string }[]>`
      select stripe_ref, reason, actual_price_id from pass_mint_refusals
       where competition_id = ${PROBE_COMP}`;
    // The session id, because this fixture carries no payment intent — the
    // documented fallback, exercised against a real session rather than asserted
    // about one.
    expect(row).toMatchObject({
      stripe_ref: sessionId,
      reason: "price_mismatch",
      actual_price_id: priceId,
    });
  });

  it("MINTS unverified when the rung has no configured price, without asking Stripe", async () => {
    // The fail-open arm, live: an unsynced environment must keep selling passes.
    await sql`update plans set stripe_price_id_onetime = null where key = 'event_pass'`;
    expect(await passSessionRungMatchesPrice(asSession(), "event_pass", PROBE_ORG)).toBe(true);
  });
});

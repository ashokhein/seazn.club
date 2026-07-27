// LIVE contract probe for the Event Pass L rung (v17 #294) — NOT a unit test.
//
// `buildPassCheckoutParams` and `passPrice` are pure functions and are already
// unit-tested to death. The questions only a real Stripe call can answer are:
//
//   1. did `npm run stripe:sync` actually push L's $59 price point into this
//      Stripe account, at every currency the seed sets?
//   2. did it write that price id back onto `plans.event_pass_l`, which is the
//      single thing standing between the checkout route and a permanent 503 for
//      L (`api/billing/pass-checkout/route.ts` — a rung with a NULL one-time
//      price id is refused rather than silently sold at the other rung's price)?
//   3. when a session is opened for L, does STRIPE quote the amount the app
//      ADVERTISES for L? `passPrice()` is display-only and the charge comes from
//      `plans.stripe_price_id_onetime`; the two are independent lookups, and
//      currency.ts:88 says in as many words that a divergence between them is
//      "invisible to every test that does not compare the two". This file is
//      that comparison, against the live API, for BOTH rungs.
//
// ── Deliberately NOT self-contained ─────────────────────────────────────────
// An earlier draft minted its own throwaway product + price so it could pass on
// an account that had never been synced. That is the wrong shape for THIS task:
// the deliverable of #294's live-probe step is that L is buyable, and a probe
// carrying its own price would have stayed green in an environment where
// `stripe:sync` had never run and every L purchase 503'd. So the sync is the
// subject, not a precondition — and when it is missing these tests FAIL with a
// message naming the command to run, rather than skipping quietly.
//
// Skipped unless BILLING_LIVE=1. Runs against Stripe TEST mode — the key
// `vitest.config.ts` loads is the repo-root `.env.local`'s `sk_test_*` — and
// expires every session it opens; no real money moves and nothing is created in
// the Stripe account. Run:
//
//   BILLING_LIVE=1 \
//   DATABASE_URL=postgres://postgres@127.0.0.1:54329/seazn_test \
//   DATABASE_SSL=disable DB_SCHEMA=<your schema> \
//     npx vitest run --root apps/web --testTimeout=30000 \
//       src/lib/__tests__/pass-checkout-l.live.test.ts
//
// (The key comes from the repo-root `.env.local`, which vitest.config.ts loads
// for exactly this suite — see its BILLING_LIVE note. 30s: the default 5s is not
// enough for four round trips to Stripe.)
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { buildPassCheckoutParams } from "@/lib/billing";
import { PASS_KEYS, passPrice, type PassKey } from "@/lib/currency";
import { sql } from "@/lib/db";
import stripePlans from "@/config/stripe-plans.json";

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
// Both `sk_test_*` and `rk_test_*` count, because the repo genuinely has two
// test-mode keys in two files: `vitest.config.ts` loads the REPO-ROOT
// `.env.local` (an `sk_test_*` key, which is what every BILLING_LIVE suite
// including this one actually runs on), while `apps/web/.env.local` holds an
// `rk_test_*` restricted key that only `npm run stripe:sync` reads. Accepting
// both prefixes means this suite runs whichever file an environment has,
// instead of skipping on a key that would have worked. Test mode itself is
// asserted below, so a LIVE key cannot slip through this gate either.
const LIVE = process.env.BILLING_LIVE === "1" && !!KEY;

/** The rung under test, and its sibling — read from the seed, never retyped. */
const SEED = Object.fromEntries(
  (stripePlans.passes ?? []).map((p) => [p.key, p]),
) as Record<string, (typeof stripePlans.passes)[number] | undefined>;

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

/** The price id the CHECKOUT ROUTE would use for a rung — the same
 *  `plans.stripe_price_id_onetime` read, so this probe cannot pass against a
 *  price the route would never reach for. */
async function routePriceId(passKey: PassKey): Promise<string | null> {
  const [row] = await sql<{ price_id: string | null }[]>`
    select stripe_price_id_onetime as price_id from plans where key = ${passKey}`;
  return row?.price_id ?? null;
}

/**
 * The Stripe client, built on FIRST USE and never at module or describe scope.
 *
 * `describe.skipIf` marks the tests as skipped but still RUNS the describe
 * callback, so a `const stripe = new Stripe(KEY)` there throws "Neither apiKey
 * nor config.authenticator provided" wherever no key is set — CI, and any local
 * run without BILLING_LIVE. That is a COLLECTION failure, not a skip: vitest
 * reports the file as `numTotalTests: 0, pass 0, fail 0` with `success: false`,
 * and the rtk wrapper renders it as `PASS (0) FAIL (0)` on exit 0 — a
 * whole-file outage that reads as a clean skip. Observed on this very file
 * before this indirection existed; do not inline it back.
 */
let client: Stripe | undefined;
const stripeClient = (): Stripe => (client ??= new Stripe(KEY));

/** Open a REAL checkout session exactly as the route builds it, and schedule its
 *  expiry. Returns Stripe's own view of it, not ours. */
async function openSession(
  passKey: PassKey,
  priceId: string,
  currency: string,
): Promise<Stripe.Checkout.Session> {
  const session = await stripeClient().checkout.sessions.create(
    buildPassCheckoutParams({
      priceId,
      passKey,
      orgId: `org-${passKey}-probe`,
      competitionId: `comp-${passKey}-probe`,
      competitionName: "L Probe Cup",
      returnUrl: "https://app.test/return?session_id={CHECKOUT_SESSION_ID}",
      currency,
      customerEmail: `pass-probe-${passKey}-${Date.now()}@example.com`,
    }),
  );
  cleanup.push(() => stripeClient().checkout.sessions.expire(session.id));
  return session;
}

describe.skipIf(!LIVE)("Event Pass L, live Stripe (test mode)", () => {
  it("is a TEST-mode key and the seed carries both rungs", () => {
    // Never printed — `toContain` on a failure would echo the key, so assert a
    // derived boolean instead.
    expect(
      KEY.includes("_test_"),
      "STRIPE_SECRET_KEY is not a test-mode key",
    ).toBe(true);
    expect(
      process.env.DATABASE_URL,
      "DATABASE_URL is required — this probe reads `plans`",
    ).toBeTruthy();
    expect(Object.keys(SEED).sort().join(",")).toBe(
      [...PASS_KEYS].sort().join(","),
    );
  });

  it("has L's $59 price synced into Stripe at every currency the seed sets", async () => {
    const seed = SEED.event_pass_l!;
    const found = await stripeClient().prices.list({
      lookup_keys: [seed.price.lookup_key],
      limit: 1,
      expand: ["data.currency_options"],
    });
    const price = found.data[0];
    expect(
      !!price,
      `no Stripe price carries lookup_key '${seed.price.lookup_key}' — run \`npm run stripe:sync\`; ` +
        `until it has, plans.event_pass_l.stripe_price_id_onetime stays NULL and every L checkout 503s`,
    ).toBe(true);

    expect(price!.active).toBe(true);
    expect(price!.type).toBe("one_time");
    expect(price!.billing_scheme).toBe("per_unit");
    expect(price!.currency).toBe(stripePlans.currency);
    // Scalar first: the whole-object compare below elides past the second key in
    // the JSON reporter, and "expected 2900 to be 5900" is the actual mis-sale.
    expect(price!.unit_amount).toBe(seed.price.unit_amount);

    // Every SET per-currency point, compared as joined strings so the reporter
    // prints both sides instead of `Object(4)`.
    const live = Object.entries(price!.currency_options ?? {})
      .map(([c, v]) => `${c}=${v.unit_amount}`)
      .sort()
      .join(" ");
    const wanted = Object.entries({
      ...seed.price.currency_options,
      [stripePlans.currency]: seed.price.unit_amount,
    })
      .map(([c, v]) => `${c}=${v}`)
      .sort()
      .join(" ");
    expect(live).toBe(wanted);

    // Two rungs, two products. If the lookup keys ever collapsed onto one price,
    // every assertion above would still pass while both rungs charged the same.
    const m = await stripeClient().prices.list({
      lookup_keys: [SEED.event_pass!.price.lookup_key],
      limit: 1,
    });
    expect(
      m.data[0]?.id,
      "M and L must not resolve to the same Stripe price",
    ).not.toBe(price!.id);
  });

  it("has written that price id onto `plans`, so the L checkout route no longer 503s", async () => {
    const l = await routePriceId("event_pass_l");
    expect(
      l,
      "plans.event_pass_l.stripe_price_id_onetime is NULL — the route returns 503 " +
        "'Billing is not yet configured' for every L purchase in this environment; run `npm run stripe:sync`",
    ).toBeTruthy();

    // It must be the price the previous test verified, not merely *some* id.
    const found = await stripeClient().prices.list({
      lookup_keys: [SEED.event_pass_l!.price.lookup_key],
      limit: 1,
    });
    expect(l).toBe(found.data[0]?.id);

    const m = await routePriceId("event_pass");
    expect(
      m,
      "plans.event_pass has no one-time price id either — sync the whole seed",
    ).toBeTruthy();
    expect(
      l,
      "both rungs point at ONE price: whichever rung is picked, one of them mischarges",
    ).not.toBe(m);
  });

  it.each([...PASS_KEYS])(
    "quotes %s at exactly the price the app advertises for it, and stamps that rung",
    async (passKey) => {
      const priceId = await routePriceId(passKey);
      expect(
        priceId,
        `plans.${passKey} is unsynced — run \`npm run stripe:sync\``,
      ).toBeTruthy();

      const session = await openSession(passKey, priceId!, "usd");

      expect(session.status).toBe("open");
      // THE comparison currency.ts:88 says nothing else makes: what the page
      // advertises for this rung against what Stripe will actually collect.
      expect(session.amount_total).toBe(passPrice("usd", passKey));
      expect(session.currency).toBe("usd");
      // The metadata is the ONLY thing telling reconcile/webhook which rung was
      // bought — a session priced for L but stamped M entitles the wrong caps.
      expect(session.metadata?.pass_key).toBe(passKey);
      expect(session.metadata?.competition_id).toBe(`comp-${passKey}-probe`);
      expect(session.metadata?.org_id).toBe(`org-${passKey}-probe`);
      // The buyer's invoice PDF. Both rungs otherwise draw an identical document
      // differing only in the amount.
      expect(session.invoice_creation?.invoice_data?.description).toBe(
        passKey === "event_pass_l"
          ? "Event Pass L — L Probe Cup"
          : "Event Pass — L Probe Cup",
      );
    },
    30_000,
  );

  it("collects L's SET £49 in gbp — not an FX conversion of $59, and not M's £25", async () => {
    const priceId = await routePriceId("event_pass_l");
    // Guarded, not asserted-by-crash: without this an unsynced rung reaches
    // Stripe as an empty `line_items[0][price]` and the run reports a generic
    // API error instead of naming the command that fixes it.
    expect(
      priceId,
      "plans.event_pass_l is unsynced — run `npm run stripe:sync`",
    ).toBeTruthy();
    const session = await openSession("event_pass_l", priceId!, "gbp");

    expect(session.currency).toBe("gbp");
    expect(session.amount_total).toBe(
      SEED.event_pass_l!.price.currency_options.gbp,
    );
    expect(session.amount_total).toBe(passPrice("gbp", "event_pass_l"));
    expect(
      session.amount_total,
      "L is quoting M's £25 — the rung's price point did not reach Stripe",
    ).not.toBe(SEED.event_pass!.price.currency_options.gbp);
    // Adaptive Pricing would re-quote at render time from the buyer's IP,
    // which is the defect #191 fixed; the builder disables it and this is the
    // only place that can observe Stripe accepting that.
    expect(session.adaptive_pricing?.enabled ?? false).toBe(false);
  }, 30_000);
});

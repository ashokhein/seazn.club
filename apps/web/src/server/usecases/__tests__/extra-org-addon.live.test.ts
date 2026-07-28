// LIVE verification for the extra-organisation recurring add-on (v17 gap
// #293) — NOT a unit test. Every other test in this wave mocks Stripe; this
// asks a real (test-mode) Stripe account to actually add the item to a
// subscription, then runs the REAL webhook writer
// (syncOrgAddonsForSubscription) against a scratch DB row, proving the whole
// pipeline: catalog -> Stripe item -> webhook -> org_addons -> resolver.
//
// It exists because THREE premises this wave is built on were modelled rather
// than observed. Each has its own `it` below, named for the premise:
//
//   1. `transfer_lookup_key: true` leaves the SUPERSEDED price reporting
//      `lookup_key: null`, and a live subscription item riding that price
//      reports the null too (the item holds a REFERENCE to the Price, not a
//      snapshot of it). isOrgAddonItem()'s metadata fallback is therefore the
//      only thing that keeps a rider's row alive across a drift replacement —
//      and an item created WITHOUT the `metadata.feature_key` stamp is
//      silently cancelled by this very sync while the customer keeps paying.
//   2. `subscriptionItems.update(id, { price })` reverts quantity to 1 unless
//      `quantity` is restated. convergeOrgAddonPrices restates it BECAUSE of
//      this; if that line were dropped an upgrading 5-rider group would be cut
//      to 1 and the row sync would faithfully record the loss as a correct
//      reconcile. Both halves are asserted: restated survives, omitted does not.
//   3. A MONTHLY rider is legal on an ANNUAL subscription. Stripe only permits
//      mixed item intervals under `billing_mode: flexible`, and the buyer copy
//      now promises "billed monthly on top of your current bill".
//
// Skipped unless BILLING_LIVE=1 AND a TEST-mode key AND DATABASE_URL. Under
// BILLING_LIVE=1, apps/web/vitest.config.ts keeps STRIPE_SECRET_KEY from the
// repo-root .env.local (it strips it otherwise). Everything created here is
// cleaned up in reverse order of creation; no real money moves. Run:
//
//   BILLING_LIVE=1 DATABASE_URL=postgres://postgres@127.0.0.1:54329/seazn_test \
//     DATABASE_SSL=disable DB_SCHEMA=<yours> \
//     npx vitest run --root apps/web extra-org-addon.live
//
// NOT self-contained on the catalog: tests 1, 2 and 5 resolve the REAL
// `seazn_extra_org_*` prices through resolveOrgAddonPriceId, so an account
// where `npm run stripe:sync` has not been run fails with its 503 rather than
// passing against prices this file minted for itself. That is deliberate — a
// live suite that mints its own catalog cannot tell you the live catalog is
// wrong, and the two rider rates ($9 Pro / $19 Pro Plus) are exactly the thing
// that must not drift.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import {
  ORG_ADDONS,
  ORG_ADDON_DELTA_EACH,
  ORG_ADDON_FEATURE_KEY,
  orgAddonPriceMinor,
  resolveOrgAddonPriceId,
} from "@/lib/org-addons";
import { convergeOrgAddonPrices, syncOrgAddonsForSubscription } from "../billing-events";

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const TEST_KEY = KEY.startsWith("sk_test") || KEY.startsWith("rk_test");
// A loud refusal, not a silent skip: this file CREATES products, prices,
// customers and subscriptions. Asked to run live against a key that is not a
// test key, the only safe answer is to stop the run.
if (process.env.BILLING_LIVE === "1" && KEY && !TEST_KEY) {
  throw new Error(
    "extra-org-addon.live: BILLING_LIVE=1 with a NON-TEST STRIPE_SECRET_KEY — refusing to run. " +
      "This suite creates real Stripe objects.",
  );
}
const LIVE = process.env.BILLING_LIVE === "1" && TEST_KEY && !!process.env.DATABASE_URL;

/** LIFO — a price cannot be archived while its product still needs it, and a
 *  product cannot be archived while it has an active price. Registering in
 *  creation order and unwinding backwards gets both right without thought. */
const cleanup: Array<() => Promise<unknown>> = [];
const seededOrgIds: string[] = [];
const seededUserIds: string[] = [];

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  if (LIVE) {
    await sql`delete from org_addons where wallet_id = any(${seededOrgIds})`.catch(() => undefined);
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
       where id = any(${seededOrgIds}) and subscription_id is not null`.catch(() => []);
    await sql`delete from organizations where id = any(${seededOrgIds})`.catch(() => undefined);
    if (groups.length) {
      await sql`delete from org_addons where wallet_id = any(${groups.map((g) => g.subscription_id)})`.catch(
        () => undefined,
      );
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`.catch(
        () => undefined,
      );
    }
    await sql`delete from users where id = any(${seededUserIds})`.catch(() => undefined);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  // ~40 sequential Stripe round trips. Vitest's DEFAULT hook timeout is 10s and
  // a hook that blows it fails the SUITE while every test still reports as
  // passed — `success: false` with `numFailedTests: 0`, which reads exactly
  // like a clean pass in any summary that only counts tests. Worse, the
  // teardown is abandoned mid-way, so throwaway customers and subscriptions are
  // stranded in an account other tasks share. Observed 2026-07-28 the moment a
  // sixth test pushed the unwind past 10s.
}, 180_000);

describe.skipIf(!LIVE)("extra-org add-on (live Stripe, test mode)", () => {
  // Constructed in beforeAll, NOT in the describe body: vitest evaluates the
  // describe factory during COLLECTION even when skipIf is true, so
  // `new Stripe(process.env.STRIPE_SECRET_KEY!)` at body scope throws
  // "Neither apiKey nor config.authenticator provided" on every ordinary run —
  // a suite-collection failure (pass 0 / fail 0, zero assertions) that reads
  // like a clean skip. pass-credit.live.test.ts documents the same trap.
  let stripe: Stripe;
  beforeAll(() => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  });

  const uniq = () => randomUUID().slice(0, 8);

  /** A throwaway recurring price on its own throwaway product. `lookupKey` is
   *  deliberately NOT a catalog key unless a test says otherwise — stealing a
   *  real `seazn_extra_org_*` key with transfer_lookup_key would leave the
   *  live catalog price permanently keyless for every other task sharing this
   *  account. */
  async function throwawayPrice(opts: {
    amount: number;
    interval?: "month" | "year";
    lookupKey?: string;
    transfer?: boolean;
    product?: string;
  }): Promise<Stripe.Price> {
    let productId = opts.product;
    if (!productId) {
      const product = await stripe.products.create({ name: `t8-org-addon-probe-${uniq()}` });
      cleanup.push(() => stripe.products.update(product.id, { active: false }));
      productId = product.id;
    }
    const price = await stripe.prices.create({
      product: productId,
      currency: "usd",
      unit_amount: opts.amount,
      recurring: { interval: opts.interval ?? "month" },
      ...(opts.lookupKey
        ? { lookup_key: opts.lookupKey, ...(opts.transfer ? { transfer_lookup_key: true } : {}) }
        : {}),
    });
    cleanup.push(() => stripe.prices.update(price.id, { active: false }));
    return price;
  }

  /** A customer with a working card and a subscription on `basePrice`. */
  async function throwawaySubscription(basePrice: string): Promise<Stripe.Subscription> {
    const customer = await stripe.customers.create({
      email: `t8-org-addon-probe-${uniq()}@example.com`,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    cleanup.push(() => stripe.customers.del(customer.id));
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: basePrice, quantity: 1 }],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));
    return sub;
  }

  /** A real billing group in the scratch schema: user -> org -> subscriptions
   *  row, pinned to `planKey`/active. Returns the WALLET id, which is what
   *  syncOrgAddonsForSubscription writes rows against. */
  async function scratchGroup(planKey = "pro"): Promise<{ orgId: string; walletId: string }> {
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`t8-org-addon-probe-${randomUUID()}@test.local`}, 'T8 Probe Owner', true)
      returning id`;
    seededUserIds.push(owner!.id);
    const org = await createOrgForUser(owner!.id, `T8 Org Addon Probe ${uniq()}`);
    seededOrgIds.push(org.id);
    const walletId = await walletIdFor(org.id);
    await sql`
      update subscriptions set plan_key = ${planKey}, status = 'active' where id = ${walletId}`;
    return { orgId: org.id, walletId };
  }

  async function addonRows(walletId: string) {
    return sql<
      {
        stripe_item_id: string;
        qty: number;
        status: string;
        feature_key: string;
        delta_each: number;
        target_org_id: string | null;
      }[]
    >`
      select stripe_item_id, qty, status, feature_key, delta_each, target_org_id
        from org_addons where wallet_id = ${walletId} order by stripe_item_id`;
  }

  it("resolves BOTH live rider rates from the catalog, and Pro Plus is the dearer one", async () => {
    // The tier ladder is only un-arbitrage-able if the LIVE prices carry the
    // two rates, not just stripe-plans.json. `orgAddonPriceMinor` reads the
    // seed; `resolveOrgAddonPriceId` reads the account. This is the one test
    // that pins them to each other.
    expect(ORG_ADDONS.map((e) => e.planKey).sort()).toEqual(["pro", "pro_plus"]);

    const rates: Record<string, number> = {};
    for (const entry of ORG_ADDONS) {
      const priceId = await resolveOrgAddonPriceId(entry.planKey);
      const price = await stripe.prices.retrieve(priceId);
      expect(price.lookup_key, `${entry.planKey} rider resolved by lookup_key`).toBe(
        entry.lookupKey,
      );
      expect(price.active).toBe(true);
      // Never annual, on any plan — the rider is a monthly line regardless of
      // the group's own interval, which is what the buyer copy promises.
      expect(price.recurring?.interval, `${entry.planKey} rider must bill MONTHLY`).toBe("month");
      expect(price.recurring?.usage_type).toBe("licensed");
      expect(price.currency).toBe("usd");
      // Live vs seed. A drift replacement mints a NEW price id but the same
      // amount; a hand-edit in the Dashboard is what this catches.
      expect(price.unit_amount, `${entry.planKey} live rate must match the seed`).toBe(
        orgAddonPriceMinor(entry.planKey, "usd"),
      );
      rates[entry.planKey] = price.unit_amount!;
    }

    expect(rates.pro).toBe(900);
    expect(rates.pro_plus).toBe(1_900);
    // The load-bearing inequality: at one flat rate "Pro + riders" would
    // undercut Pro Plus. If these ever equalise the ladder is arbitrage-able.
    expect(rates.pro_plus).toBeGreaterThan(rates.pro);
  }, 60_000);

  it("rides the group's subscription as an extra item and the webhook lifts orgs.max_owned", async () => {
    const proPriceId = await resolveOrgAddonPriceId("pro");
    const basePrice = await throwawayPrice({ amount: 1_900 });
    const sub = await throwawaySubscription(basePrice.id);

    // Exactly what setExtraOrgs sends: the catalog price, a quantity, and the
    // metadata stamp. The stamp is not decoration — test 3 shows the row is
    // cancelled without it the first time the price is re-minted.
    const item = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: proPriceId,
      quantity: 2,
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
    });

    const live = await stripe.subscriptions.retrieve(sub.id);
    const riding = live.items.data.find((i) => i.id === item.id);
    expect(riding?.quantity).toBe(2);
    // One subscription, one cycle — never a second subscription.
    expect(live.items.data).toHaveLength(2);
    expect(typeof riding!.price, "subscription items expand `price` by default").toBe("object");
    expect(riding!.price.lookup_key).toBe(ORG_ADDONS.find((e) => e.planKey === "pro")!.lookupKey);

    const { orgId, walletId } = await scratchGroup("pro");
    const [{ int_value: base }] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'pro' and feature_key = ${ORG_ADDON_FEATURE_KEY}`;
    expect(base).toBe(5);

    await syncOrgAddonsForSubscription(live, walletId);

    expect(await getLimit(orgId, ORG_ADDON_FEATURE_KEY)).toBe((base ?? 0) + 2);
    const [row] = await addonRows(walletId);
    expect(row).toMatchObject({
      stripe_item_id: item.id,
      qty: 2,
      status: "active",
      feature_key: ORG_ADDON_FEATURE_KEY,
      delta_each: ORG_ADDON_DELTA_EACH,
      // GROUP-WIDE, never scoped to one org — the half that makes this a
      // sibling of the seat sync rather than the same function.
      target_org_id: null,
    });

    // Removal, live: the customer drops the rider, Stripe stops reporting the
    // item, and the reconcile sweep FREEZES the row rather than deleting it
    // (V323/V324) — capacity goes back to the plan base.
    await stripe.subscriptionItems.del(item.id);
    const after = await stripe.subscriptions.retrieve(sub.id);
    expect(after.items.data.some((i) => i.id === item.id)).toBe(false);

    await syncOrgAddonsForSubscription(after, walletId);

    expect(await getLimit(orgId, ORG_ADDON_FEATURE_KEY)).toBe(base ?? 0);
    const [frozen] = await addonRows(walletId);
    expect(frozen).toMatchObject({ stripe_item_id: item.id, status: "canceled", qty: 2 });
  }, 60_000);

  it("PREMISE 1: a re-minted price nulls the LIVE item's lookup_key, and only the metadata stamp saves the row", async () => {
    // Read-only inspection could get as far as "the superseded PRICE object
    // reports lookup_key: null". What it could not close is whether a
    // subscription ITEM riding that price reports the null too — i.e. whether
    // the item holds a reference or a snapshot. Everything downstream
    // (isOrgAddonItem's fallback, convergeOrgAddonPrices comparing by price ID
    // rather than lookup key) is built on the reference answer. This asks.
    //
    // The probe uses its OWN lookup keys, never `seazn_extra_org_*`:
    // transfer_lookup_key MOVES the key, so borrowing a catalog key would
    // leave the live catalog price permanently keyless for every other task
    // sharing this test account.
    const keyStamped = `seazn-t8-stamped-${uniq()}`;
    const keyBare = `seazn-t8-bare-${uniq()}`;
    const oldStamped = await throwawayPrice({ amount: 900, lookupKey: keyStamped });
    const oldBare = await throwawayPrice({ amount: 900, lookupKey: keyBare });
    const basePrice = await throwawayPrice({ amount: 1_900 });
    const sub = await throwawaySubscription(basePrice.id);

    // Two riders: one created the way setExtraOrgs creates them (stamped), one
    // the way a Dashboard edit or a pre-stamp code path would (bare).
    const stamped = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: oldStamped.id,
      quantity: 3,
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
    });
    const bare = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: oldBare.id,
      quantity: 1,
    });

    const before = await stripe.subscriptions.retrieve(sub.id);
    const beforeStamped = before.items.data.find((i) => i.id === stamped.id)!;
    expect(beforeStamped.price.lookup_key, "the item reports its price's key before the swap").toBe(
      keyStamped,
    );

    // The drift replacement stripe-sync.ts performs: mint the corrected price
    // and MOVE the lookup key onto it. Amounts are immutable in Stripe, so
    // this — not an update — is how a price change ships.
    const newStamped = await throwawayPrice({
      amount: 1_000,
      lookupKey: keyStamped,
      transfer: true,
      product: typeof oldStamped.product === "string" ? oldStamped.product : undefined,
    });
    const newBare = await throwawayPrice({
      amount: 1_000,
      lookupKey: keyBare,
      transfer: true,
      product: typeof oldBare.product === "string" ? oldBare.product : undefined,
    });
    expect(newStamped.lookup_key).toBe(keyStamped);
    expect(newBare.lookup_key).toBe(keyBare);
    // The superseded PRICE object — the half that was already observed.
    expect((await stripe.prices.retrieve(oldStamped.id)).lookup_key).toBeNull();

    const after = await stripe.subscriptions.retrieve(sub.id);
    const liveStamped = after.items.data.find((i) => i.id === stamped.id)!;
    const liveBare = after.items.data.find((i) => i.id === bare.id)!;

    // ==== PREMISE 1, observed ====
    // The items never moved — they still hold the OLD price ids — yet both now
    // report a null lookup_key. So `item.price` IS a live reference, and any
    // handler matching riders on lookup_key alone stops recognising a rider
    // the moment its price is re-minted, with no event of its own.
    expect(liveStamped.price.id).toBe(oldStamped.id);
    expect(liveBare.price.id).toBe(oldBare.id);
    expect(liveStamped.price.lookup_key).toBeNull();
    expect(liveBare.price.lookup_key).toBeNull();

    // …which is why isOrgAddonItem falls back to the metadata stamp. Neither
    // item's key is a catalog key, so before the swap both were unrecognised;
    // after it, the stamped one is recognised and the bare one is not.
    const { walletId } = await scratchGroup("pro");
    // Both riders already have live rows — this is a group that has been
    // paying for them, which is what makes the next assertion a REVOCATION
    // rather than a failure to create.
    for (const [itemId, qty] of [
      [stamped.id, 3],
      [bare.id, 1],
    ] as const) {
      await sql`
        insert into org_addons
          (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
           stripe_item_id, status)
        values (${walletId}, null, null, ${ORG_ADDON_FEATURE_KEY}, ${ORG_ADDON_DELTA_EACH},
                ${qty}, ${itemId}, 'active')`;
    }

    await syncOrgAddonsForSubscription(after, walletId);

    const rows = Object.fromEntries((await addonRows(walletId)).map((r) => [r.stripe_item_id, r]));
    // The stamped rider survives its price being re-minted…
    expect(rows[stamped.id]).toMatchObject({ status: "active", qty: 3 });
    // …and the UNSTAMPED one is cancelled by the reconcile sweep while the
    // customer is still being billed for it. That is the production hazard the
    // stamp exists to close, and it is only reachable once the lookup_key has
    // gone null — i.e. it depends on exactly the premise above.
    expect(rows[bare.id]).toMatchObject({ status: "canceled" });
  }, 90_000);

  it("PREMISE 2: re-pricing an item reverts quantity to 1 unless quantity is restated", async () => {
    // convergeOrgAddonPrices passes `quantity` explicitly on the strength of
    // one sentence in Stripe's docs. Until now the invariant was pinned only
    // against a mock written from that sentence — i.e. the test and the code
    // shared a single source of belief. This asks the API.
    const p1 = await throwawayPrice({ amount: 900 });
    const p2 = await throwawayPrice({ amount: 1_900 });
    const p3 = await throwawayPrice({ amount: 1_900 });
    const basePrice = await throwawayPrice({ amount: 1_900 });
    const sub = await throwawaySubscription(basePrice.id);

    const item = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: p1.id,
      quantity: 5,
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
    });
    expect(item.quantity).toBe(5);

    // (a) EXACTLY what convergeOrgAddonPrices sends on a tier change.
    const restated = await stripe.subscriptionItems.update(item.id, {
      price: p2.id,
      quantity: 5,
      proration_behavior: "create_prorations",
    });
    expect(restated.price.id).toBe(p2.id);
    // The item id is PRESERVED by an in-place update — every org_addons row
    // keyed on stripe_item_id stays valid, which is why this is not a
    // delete+create.
    expect(restated.id).toBe(item.id);
    // Read back live rather than trusting the update's own response object.
    const afterRestated = await stripe.subscriptionItems.retrieve(item.id);
    expect(afterRestated.quantity, "restated quantity must survive a price change").toBe(5);

    // (b) The SAME call with the quantity line dropped — the hole the code's
    // explicit `quantity:` closes.
    await stripe.subscriptionItems.update(item.id, {
      price: p3.id,
      proration_behavior: "create_prorations",
    });
    const afterOmitted = await stripe.subscriptionItems.retrieve(item.id);
    // ==== PREMISE 2, observed ====
    expect(afterOmitted.price.id).toBe(p3.id);
    expect(afterOmitted.quantity, "omitting quantity on a price change resets it to 1").toBe(1);

    // And the damage is not confined to Stripe: the row sync is the single
    // writer, so it records the loss as a perfectly ordinary reconcile. Four
    // organisations of paid capacity vanish with nothing to alert on — which
    // is the whole reason the `quantity:` line is not optional.
    const { orgId, walletId } = await scratchGroup("pro");
    const damaged = await stripe.subscriptions.retrieve(sub.id);
    await syncOrgAddonsForSubscription(damaged, walletId);
    const [row] = await addonRows(walletId);
    expect(row).toMatchObject({ stripe_item_id: item.id, qty: 1, status: "active" });
    expect(await getLimit(orgId, ORG_ADDON_FEATURE_KEY)).toBe(6); // 5 + 1, not 5 + 5
  }, 90_000);

  it("converges a Pro rider onto the Pro Plus price against real Stripe, WITHOUT losing quantity", async () => {
    // PREMISE 2 applied. The test above establishes what Stripe does; this one
    // establishes that convergeOrgAddonPrices survives it, on a real
    // subscription, with the real catalog prices. Delete the `quantity:` line
    // from that function and this is the test that reds — the assertion above
    // would still pass, because Stripe's behaviour would not have changed.
    const proPriceId = await resolveOrgAddonPriceId("pro");
    const plusPriceId = await resolveOrgAddonPriceId("pro_plus");
    expect(plusPriceId).not.toBe(proPriceId);

    const basePrice = await throwawayPrice({ amount: 3_900 });
    const sub = await throwawaySubscription(basePrice.id);
    const item = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: proPriceId,
      quantity: 5,
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
    });

    // The group has already been moved to Pro Plus by syncSubscriptionForGroup;
    // its rider is still on the $9 SKU. That is the arbitrage the two rates
    // exist to close, and convergence is what closes it.
    const { orgId, walletId } = await scratchGroup("pro_plus");
    const live = await stripe.subscriptions.retrieve(sub.id);

    await convergeOrgAddonPrices(live, walletId);

    const reprice = await stripe.subscriptionItems.retrieve(item.id);
    expect(reprice.price.id, "the rider must move onto the Pro Plus SKU").toBe(plusPriceId);
    // In place: the id the org_addons row is keyed on is unchanged.
    expect(reprice.id).toBe(item.id);
    // The whole point. Stripe silently resets this to 1 unless it is restated.
    expect(reprice.quantity, "convergence must not revoke paid capacity").toBe(5);

    // Production runs these back to back on the same object (handleSubscription
    // Updated), so the row sync must see the POST-convergence item.
    await syncOrgAddonsForSubscription(live, walletId);
    const [row] = await addonRows(walletId);
    expect(row).toMatchObject({ stripe_item_id: item.id, qty: 5, status: "active" });
    expect(await getLimit(orgId, ORG_ADDON_FEATURE_KEY)).toBe(15); // pro_plus base 10 + 5
  }, 90_000);

  it("PREMISE 3: a MONTHLY rider is legal on an ANNUAL subscription", async () => {
    // The buyer copy says the rider is "billed monthly on top of your current
    // bill", and an annual group is precisely the case that claim is about.
    // Stripe permits mixed item intervals on one subscription only under
    // `billing_mode: flexible`; nothing asserted that this account — or a
    // freshly created subscription on it — actually is.
    const annualBase = await throwawayPrice({ amount: 12_500, interval: "year" });
    const sub = await throwawaySubscription(annualBase.id);
    expect(
      (sub as unknown as { billing_mode?: { type?: string } }).billing_mode?.type,
      "mixed item intervals require billing_mode: flexible",
    ).toBe("flexible");

    const proPriceId = await resolveOrgAddonPriceId("pro");
    // The call that would throw if mixed intervals were refused.
    const rider = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: proPriceId,
      quantity: 1,
      metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
    });

    const live = await stripe.subscriptions.retrieve(sub.id);
    const base = live.items.data.find((i) => i.id !== rider.id)!;
    const riding = live.items.data.find((i) => i.id === rider.id)!;
    // ==== PREMISE 3, observed ====
    expect(base.price.recurring?.interval).toBe("year");
    expect(riding.price.recurring?.interval).toBe("month");
    expect(live.items.data).toHaveLength(2);

    // …and the webhook writer treats it identically to the monthly case: the
    // cap lift does not depend on the group's own interval.
    const { orgId, walletId } = await scratchGroup("pro");
    await syncOrgAddonsForSubscription(live, walletId);
    expect(await getLimit(orgId, ORG_ADDON_FEATURE_KEY)).toBe(6);
  }, 90_000);
});

// v17 gap #332: the extra-organisation rider is sold at two rates ($9/mo on
// pro, $19/mo on pro_plus) and `convergeOrgAddonPrices` deliberately NEVER
// THROWS, so every one of its failure paths leaves a group billing the wrong
// rate with nothing scheduled to try again. Convergence only runs when Stripe
// emits a `customer.subscription.created`/`.updated` for that group, so "a
// later plan change re-converges it" is worth nothing for a group that never
// changes plan again.
//
// `sweepStaleOrgAddonPrices` is the backstop: a periodic pass that compares
// every live rider's ACTUAL Stripe price id against its group's current plan
// rate and REPORTS the disagreements. It never re-prices — see the function's
// doc comment for why a bulk billing mutation is not what ships first.
//
// Real Postgres required; skipped without DATABASE_URL.
//
// CONCURRENCY-SAFE BY CONSTRUCTION. The sweep reads every live rider in the
// database, so sibling suites running against the same DB — and rows left by
// earlier runs of this file — are inside its working set. Nothing here asserts
// a total: every count assertion is derived from the entries THIS test seeded
// (filtered by item id), and the `prices.list`/`subscriptionItems.retrieve`
// stubs answer for an unknown item with "already converged" so a foreign row
// can never manufacture a mismatch of its own.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { itemRetrieveSpy, pricesListSpy, repriceAlertSpy } = vi.hoisted(() => ({
  itemRetrieveSpy: vi.fn(),
  pricesListSpy:
    vi.fn<(args: { lookup_keys: string[]; limit?: number }) => Promise<{ data: { id: string }[] }>>(),
  // Typed with the one field the assertions read, so `mock.calls[n][0]` is a
  // real argument rather than the empty tuple a zero-arity `vi.fn()` infers.
  repriceAlertSpy: vi.fn<(opts: { itemId: string | null }) => Promise<boolean>>(async () => true),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptionItems: { retrieve: itemRetrieveSpy },
    prices: { list: pricesListSpy },
  }),
}));
// Partial mock: billing-events.ts imports a dozen senders from this module, so
// only the one the sweep raises is replaced.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendExtraOrgRepriceFailedAlertEmail: repriceAlertSpy,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  ORG_ADDONS,
  ORG_ADDON_DELTA_EACH,
  ORG_ADDON_FEATURE_KEY,
} from "@/lib/org-addons";
import { sweepStaleOrgAddonPrices } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** The live price id this suite pretends `stripe:sync` produced for a plan.
 *  Derived from the lookup key so pro and pro_plus can never collide. */
const proEntry = ORG_ADDONS.find((e) => e.planKey === "pro")!;
const proPlusEntry = ORG_ADDONS.find((e) => e.planKey === "pro_plus")!;
const livePriceFor = (lookupKey: string) => `price_live_${lookupKey}`;

/** Every item id this file mints carries this prefix, which is how each
 *  assertion narrows the sweep's whole-database result to its own rows. */
const ITEM_PREFIX = "si_sweep332_";
const mine = <T extends { itemId: string }>(rows: T[]) =>
  rows.filter((r) => r.itemId.startsWith(ITEM_PREFIX));

/** A billed group on `planKey` carrying one ACTIVE extra-org rider row. */
async function seedRider(
  planKey: "pro" | "pro_plus" | "community",
  qty = 1,
): Promise<{ groupId: string; orgId: string; stripeSubId: string; itemId: string }> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`sweep332-${uniq()}@test.local`}, 'Sweep Owner', true) returning id`;
  const org = await createOrgForUser(user!.id, `Sweep 332 ${uniq()}`);
  const groupId = await setOrgPlan(org.id, planKey);
  const stripeSubId = `sub_sweep332_${uniq()}`;
  await sql`
    update subscriptions set stripe_subscription_id = ${stripeSubId}, status = 'active'
     where id = ${groupId}`;
  const itemId = `${ITEM_PREFIX}${uniq()}`;
  await sql`
    insert into org_addons
      (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
       stripe_item_id, status)
    values (${groupId}, null, null, ${ORG_ADDON_FEATURE_KEY}, ${ORG_ADDON_DELTA_EACH},
            ${qty}, ${itemId}, 'active')`;
  return { groupId, orgId: org.id, stripeSubId, itemId };
}

/** An extra-SEAT add-on row — the OTHER add-on family riding the very same
 *  subscription, with its own SKU and its own price. It is `active`, it has a
 *  `stripe_item_id`, and its group is live, so only the feature_key keeps it
 *  out of this sweep's working set. */
async function seedSeatRow(groupId: string, orgId: string): Promise<string> {
  const itemId = `${ITEM_PREFIX}seat_${uniq()}`;
  await sql`
    insert into org_addons
      (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
       stripe_item_id, status)
    values (${groupId}, ${orgId}, null, 'members.max', 5, 1, ${itemId}, 'active')`;
  return itemId;
}

/** A Stripe subscription item as `subscriptionItems.retrieve` returns it. */
const itemOn = (id: string, priceId: string) => ({ id, price: { id: priceId } });

/** Rows THIS FILE seeded — in an earlier run, or in the test that just ran —
 *  are still `active` and still inside the sweep's whole-database working set,
 *  so `mine()` would pick up its predecessors' riders as well as its own. Drop
 *  them before every test. Scoped to this file's own item prefix, so a sibling
 *  suite's rows are never touched. */
async function clearOwnRiders(): Promise<void> {
  await sql`delete from org_addons where stripe_item_id like ${`${ITEM_PREFIX}%`}`;
}

beforeEach(async () => {
  itemRetrieveSpy.mockReset();
  pricesListSpy.mockReset();
  repriceAlertSpy.mockClear();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_sweep332");
  vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.club");
  // The synced catalog: every lookup key resolves to its own live price id.
  pricesListSpy.mockImplementation(async (args) => ({
    data: [{ id: livePriceFor(args.lookup_keys[0]!) }],
  }));
  // Default for an item this test did not seed (a sibling suite's row, or a
  // leftover): report it as ALREADY on whatever price was asked for, so a
  // foreign row can never contribute a mismatch or consume an alert slot.
  itemRetrieveSpy.mockImplementation(async (id: string) =>
    itemOn(id, livePriceFor(proEntry.lookupKey)),
  );
  if (HAS_DB) await clearOwnRiders();
});
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sweepStaleOrgAddonPrices (#332)", () => {
  it("reports a Pro Plus group whose rider is still on the Pro price", async () => {
    const { groupId, stripeSubId, itemId } = await seedRider("pro_plus", 3);
    // The exact #332 shape: convergence failed, so the $19 group still rides
    // the $9 SKU — the arbitrage the two rates exist to close.
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, id === itemId ? livePriceFor(proEntry.lookupKey) : livePriceFor(proPlusEntry.lookupKey)),
    );

    const res = await sweepStaleOrgAddonPrices();

    const found = mine(res.mismatches);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      subscriptionId: groupId,
      stripeSubscriptionId: stripeSubId,
      planKey: "pro_plus",
      itemId,
      qty: 3,
      currentPriceId: livePriceFor(proEntry.lookupKey),
      expectedPriceId: livePriceFor(proPlusEntry.lookupKey),
    });
    expect(res.mismatched).toBeGreaterThanOrEqual(1);
    expect(res.alerted).toBeGreaterThanOrEqual(1);
  });

  it("compares against LIVE Stripe state, not the org_addons row", async () => {
    // The DB knows only the item id — it never records a price. So the sweep
    // has to ask Stripe what the item is actually on; a sweep that trusted the
    // row could not detect this class at all.
    const { itemId } = await seedRider("pro");
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, id === itemId ? "price_something_else_entirely" : livePriceFor(proEntry.lookupKey)),
    );

    const res = await sweepStaleOrgAddonPrices();

    expect(itemRetrieveSpy).toHaveBeenCalledWith(itemId);
    expect(mine(res.mismatches)[0]).toMatchObject({
      itemId,
      currentPriceId: "price_something_else_entirely",
      expectedPriceId: livePriceFor(proEntry.lookupKey),
    });
  });

  it("stays silent on a converged rider — no mismatch, no alert", async () => {
    const { itemId } = await seedRider("pro");
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, livePriceFor(proEntry.lookupKey)),
    );

    const res = await sweepStaleOrgAddonPrices();

    expect(mine(res.mismatches)).toEqual([]);
    const alertedItems = repriceAlertSpy.mock.calls.map((c) => c[0].itemId);
    expect(alertedItems).not.toContain(itemId);
  });

  it("flags an unsynced catalog as unresolved and never guesses a price", async () => {
    const { itemId } = await seedRider("pro");
    // resolveOrgAddonPriceId's 503: `stripe:sync` has not run for this account.
    pricesListSpy.mockResolvedValue({ data: [] });

    const res = await sweepStaleOrgAddonPrices();

    const found = mine(res.mismatches);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ itemId, expectedPriceId: null, currentPriceId: null });
    expect(res.unresolved).toBeGreaterThanOrEqual(1);
    // Nothing to compare against, so the item is never even read.
    expect(itemRetrieveSpy).not.toHaveBeenCalledWith(itemId);
  });

  it("resolves each plan's price ONCE per pass, not once per rider", async () => {
    const a = await seedRider("pro");
    const b = await seedRider("pro");
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, livePriceFor(proEntry.lookupKey)),
    );

    await sweepStaleOrgAddonPrices();

    const proLookups = pricesListSpy.mock.calls.filter(
      (c) => c[0]!.lookup_keys[0] === proEntry.lookupKey,
    );
    expect(proLookups).toHaveLength(1);
    expect(a.itemId).not.toBe(b.itemId); // both really were in the working set
  });

  it("reports a rider on a plan that has no rider SKU at all", async () => {
    // Community has no org-addon entry, so convergeOrgAddonPrices returns
    // early and does nothing — which leaves a paid rider riding a plan that
    // cannot price it. Invisible today; the sweep is what surfaces it.
    const { itemId } = await seedRider("community");

    const res = await sweepStaleOrgAddonPrices();

    const found = mine(res.mismatches);
    expect(found).toHaveLength(1);
    expect(found[0]!.itemId).toBe(itemId);
    expect(found[0]!.reason).toMatch(/community/);
    expect(found[0]!.expectedPriceId).toBeNull();
  });

  it("skips canceled rider rows and groups Stripe no longer bills", async () => {
    const canceled = await seedRider("pro");
    await sql`update org_addons set status = 'canceled' where stripe_item_id = ${canceled.itemId}`;
    const dead = await seedRider("pro");
    await sql`update subscriptions set status = 'canceled' where id = ${dead.groupId}`;
    const unbilled = await seedRider("pro");
    await sql`update subscriptions set stripe_subscription_id = null where id = ${unbilled.groupId}`;
    // If any of the three WERE swept they would read as mismatched.
    itemRetrieveSpy.mockImplementation(async (id: string) => itemOn(id, "price_wrong"));

    const res = await sweepStaleOrgAddonPrices();

    expect(mine(res.mismatches)).toEqual([]);
    for (const id of [canceled.itemId, dead.itemId, unbilled.itemId]) {
      expect(itemRetrieveSpy).not.toHaveBeenCalledWith(id);
    }
  });

  it("ignores the extra-SEAT add-on family entirely", async () => {
    // Seats ride the same subscription and land in the same table, but they are
    // a different SKU at a different price. A sweep that selected them would
    // report every seat item in the estate as an extra-org rider on the wrong
    // price — a false positive on a scale that would bury the true ones.
    const { groupId, orgId } = await seedRider("pro");
    const seatItemId = await seedSeatRow(groupId, orgId);
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, livePriceFor(proEntry.lookupKey)),
    );

    const res = await sweepStaleOrgAddonPrices();

    expect(itemRetrieveSpy).not.toHaveBeenCalledWith(seatItemId);
    expect(mine(res.mismatches)).toEqual([]);
  });

  it("counts a vanished item separately and does not alert on it", async () => {
    const { itemId } = await seedRider("pro");
    itemRetrieveSpy.mockImplementation(async (id: string) => {
      if (id !== itemId) return itemOn(id, livePriceFor(proEntry.lookupKey));
      throw Object.assign(new Error("No such subscription item"), { code: "resource_missing" });
    });

    const res = await sweepStaleOrgAddonPrices();

    expect(res.vanished).toBeGreaterThanOrEqual(1);
    expect(mine(res.mismatches)).toEqual([]);
    const alertedItems = repriceAlertSpy.mock.calls.map((c) => c[0].itemId);
    expect(alertedItems).not.toContain(itemId);
  });

  it("a Stripe read failure is unreadable, not a mismatch — it never invents one", async () => {
    const { itemId } = await seedRider("pro");
    itemRetrieveSpy.mockImplementation(async (id: string) => {
      if (id !== itemId) return itemOn(id, livePriceFor(proEntry.lookupKey));
      throw new Error("stripe unavailable");
    });

    const res = await sweepStaleOrgAddonPrices();

    expect(res.unreadable).toBeGreaterThanOrEqual(1);
    // The whole point: a transient outage must not be reported as "this group
    // is billing the wrong rate", which is what a responder would act on.
    expect(mine(res.mismatches)).toEqual([]);
  });

  it("never re-prices: the sweep reports and mutates nothing", async () => {
    const { itemId } = await seedRider("pro_plus");
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, id === itemId ? livePriceFor(proEntry.lookupKey) : livePriceFor(proPlusEntry.lookupKey)),
    );

    await sweepStaleOrgAddonPrices();

    // `subscriptionItems.update` is not even on the stubbed client — a sweep
    // that tried to repair would throw here rather than silently mutate.
    const [row] = await sql<{ status: string; qty: number }[]>`
      select status, qty from org_addons where stripe_item_id = ${itemId}`;
    expect(row).toMatchObject({ status: "active", qty: 1 });
  });

  it("reports without alerting when STAFF_ALERT_EMAIL is unset", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const { itemId } = await seedRider("pro_plus");
    itemRetrieveSpy.mockImplementation(async (id: string) =>
      itemOn(id, id === itemId ? livePriceFor(proEntry.lookupKey) : livePriceFor(proPlusEntry.lookupKey)),
    );

    const res = await sweepStaleOrgAddonPrices();

    expect(mine(res.mismatches)).toHaveLength(1);
    expect(res.alerted).toBe(0);
    expect(repriceAlertSpy).not.toHaveBeenCalled();
  });

  it("does nothing at all without a Stripe key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await seedRider("pro_plus");

    const res = await sweepStaleOrgAddonPrices();

    expect(res).toEqual({
      total: 0,
      checked: 0,
      mismatched: 0,
      unresolved: 0,
      vanished: 0,
      unreadable: 0,
      alerted: 0,
      mismatches: [],
    });
    expect(pricesListSpy).not.toHaveBeenCalled();
  });

  it("reports its own truncation: total counts riders `limit` never reached", async () => {
    // `limit` truncates a STABLE created_at ordering over a working set that
    // never drains, so an estate larger than the limit leaves its newest riders
    // permanently unexamined. A backstop that had silently stopped covering the
    // estate would be indistinguishable from a clean pass without this.
    await seedRider("pro");
    await seedRider("pro");

    const res = await sweepStaleOrgAddonPrices(1);

    expect(res.checked).toBe(1);
    expect(res.total).toBeGreaterThan(res.checked);
  });
});

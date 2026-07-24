// v17 Phase 3 Task 3a: the extra-seat recurring add-on ($4/seat/month → +1
// members.max per seat). The seat rides the group's EXISTING Stripe
// subscription as an extra item; the ROUTE mutates Stripe, and the
// customer.subscription.updated WEBHOOK (syncSeatAddonsForSubscription) is the
// SINGLE writer of the org_addons row — so Stripe and the DB can never diverge.
// These tests drive the webhook sync against real Postgres and assert on the
// resolver (getLimit/withinLimit), plus the V324 guards and the route's
// group-payer gate.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// getLimit reads through resolve()'s entitlement cache; disable it so a
// just-written add-on row is seen on the very next read (same mock as
// org-addons-resolver.test.ts).
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

// Route-auth (IDOR) test: stub the group-payer gate so we can prove a non-payer
// is refused BEFORE any Stripe call fires, and spy on Stripe to assert it isn't.
const { retrieveSpy, itemCreateSpy, itemUpdateSpy, itemDelSpy, requireBillingOwnerMock } =
  vi.hoisted(() => ({
    retrieveSpy: vi.fn(),
    itemCreateSpy: vi.fn(),
    itemUpdateSpy: vi.fn(),
    itemDelSpy: vi.fn(),
    requireBillingOwnerMock: vi.fn(),
  }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: retrieveSpy },
    subscriptionItems: { create: itemCreateSpy, update: itemUpdateSpy, del: itemDelSpy },
    prices: { list: vi.fn(async () => ({ data: [{ id: "price_seat" }] })) },
  }),
}));
vi.mock("@/server/usecases/billing-manage", () => ({
  requireBillingOwner: requireBillingOwnerMock,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit, withinLimit } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { syncSeatAddonsForSubscription } from "../billing-events";
import { setExtraSeats } from "../extra-seats";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`seat-${uniq()}@test.local`}, 'Seat Owner', true) returning id`;
  return id;
}

/** A seat subscription item as the webhook sees it: the recurring seat SKU,
 *  its target-org metadata, and the quantity Stripe now holds. */
function seatItem(id: string, targetOrgId: string, quantity: number): Stripe.SubscriptionItem {
  return {
    id,
    quantity,
    price: { id: `price_${id}`, lookup_key: "seazn_seat_monthly" },
    metadata: { target_org_id: targetOrgId, feature_key: "members.max" },
  } as unknown as Stripe.SubscriptionItem;
}

function subWith(items: Stripe.SubscriptionItem[]): Stripe.Subscription {
  return { id: `sub_${uniq()}`, items: { data: items } } as unknown as Stripe.Subscription;
}

let planBase: number;

beforeAll(async () => {
  if (!HAS_DB) return;
  // community members.max plan_base (V319 set it to 5) — read, never hard-code.
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = 'members.max'`;
  planBase = row?.int_value ?? 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("extra-seat add-on — webhook sync → resolver", () => {
  it("a seat item (qty=1) writes ONE active row → getLimit = plan_base + 1", async () => {
    const org = await createOrgForUser(await makeUser(), "Seat Org 1");
    const walletId = await walletIdFor(org.id);
    expect(await getLimit(org.id, "members.max")).toBe(planBase);

    await syncSeatAddonsForSubscription(subWith([seatItem(`si_${uniq()}`, org.id, 1)]), walletId);

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 1);
    expect((await withinLimit(org.id, "members.max", planBase + 1)).ok).toBe(true);
    expect((await withinLimit(org.id, "members.max", planBase + 2)).ok).toBe(false);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons
       where wallet_id = ${walletId} and status = 'active'`;
    expect(n).toBe(1);
  });

  it("qty=3 lifts the cap by +3", async () => {
    const org = await createOrgForUser(await makeUser(), "Seat Org 3");
    const walletId = await walletIdFor(org.id);

    await syncSeatAddonsForSubscription(subWith([seatItem(`si_${uniq()}`, org.id, 3)]), walletId);

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 3);
  });

  it("a later event with the seat REMOVED flips the row to canceled (freeze-not-delete)", async () => {
    const org = await createOrgForUser(await makeUser(), "Seat Org Remove");
    const walletId = await walletIdFor(org.id);
    const itemId = `si_${uniq()}`;

    await syncSeatAddonsForSubscription(subWith([seatItem(itemId, org.id, 1)]), walletId);
    expect(await getLimit(org.id, "members.max")).toBe(planBase + 1);

    // The seat is gone from the subscription — cap drops back to base…
    await syncSeatAddonsForSubscription(subWith([]), walletId);
    expect(await getLimit(org.id, "members.max")).toBe(planBase);

    // …but the row is FROZEN, not deleted.
    const [row] = await sql<{ status: string }[]>`
      select status from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("canceled");
  });

  it("re-processing the SAME event is idempotent — one row, qty unchanged", async () => {
    const org = await createOrgForUser(await makeUser(), "Seat Org Idem");
    const walletId = await walletIdFor(org.id);
    const sub = subWith([seatItem(`si_${uniq()}`, org.id, 2)]);

    await syncSeatAddonsForSubscription(sub, walletId);
    await syncSeatAddonsForSubscription(sub, walletId);

    expect(await getLimit(org.id, "members.max")).toBe(planBase + 2);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(1);
  });

  it("V324: qty=0, delta_each=0 and negative delta_each are rejected by the CHECK", async () => {
    const org = await createOrgForUser(await makeUser(), "Seat Org Guard");
    const walletId = await walletIdFor(org.id);

    await expect(
      sql`insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
          values (${walletId}, ${org.id}, 'members.max', 1, 0, 'active')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
          values (${walletId}, ${org.id}, 'members.max', 0, 1, 'active')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
          values (${walletId}, ${org.id}, 'members.max', -1, 1, 'active')`,
    ).rejects.toThrow();
  });
});

describe("extra-seat route auth (IDOR)", () => {
  it("a non-payer is refused 403 before any Stripe call", async () => {
    requireBillingOwnerMock.mockRejectedValueOnce(
      new HttpError(403, "Only the person who pays for this billing group can manage its subscription."),
    );
    retrieveSpy.mockClear();
    itemCreateSpy.mockClear();

    await expect(setExtraSeats(1)).rejects.toMatchObject({ status: 403 });
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });
});

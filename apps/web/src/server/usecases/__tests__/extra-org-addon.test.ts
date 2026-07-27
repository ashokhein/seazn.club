// v17 gap #293: the extra-organisation recurring add-on ($9/mo Pro, $19/mo
// Pro Plus -> +1 orgs.max_owned per unit, GROUP-WIDE). The webhook
// (syncOrgAddonsForSubscription) is the SINGLE writer of the org_addons row;
// these tests drive it against real Postgres and assert on the resolver
// (getLimit / groupOrgLimit), mirroring extra-seat-addon.test.ts.
//
// Task 3 adds the other half: the PURCHASE usecase (setExtraOrgs), which
// mutates Stripe ONLY.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// getLimit reads through resolve()'s entitlement cache; disable it so a
// just-written add-on row is seen on the very next read (same mock as
// extra-seat-addon.test.ts).
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

// Purchase-route tests (Task 3): stub the group-payer gate so a non-payer can
// be proven refused BEFORE any Stripe call, spy on Stripe to assert exactly
// which mutation fired, and spy on the staff-alert email so the >= 25
// allowance watch is observable without sending anything.
const {
  retrieveSpy,
  itemCreateSpy,
  itemUpdateSpy,
  itemDelSpy,
  pricesListSpy,
  requireBillingOwnerMock,
} = vi.hoisted(() => ({
  retrieveSpy: vi.fn(),
  itemCreateSpy: vi.fn(),
  itemUpdateSpy: vi.fn(),
  itemDelSpy: vi.fn(),
  pricesListSpy: vi.fn(async () => ({ data: [{ id: "price_org_addon" }] })),
  requireBillingOwnerMock: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: retrieveSpy },
    subscriptionItems: { create: itemCreateSpy, update: itemUpdateSpy, del: itemDelSpy },
    prices: { list: pricesListSpy },
  }),
}));
vi.mock("@/server/usecases/billing-manage", () => ({
  requireBillingOwner: requireBillingOwnerMock,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import { groupOrgLimit } from "@/lib/billing-group";
import { HttpError } from "@/lib/errors";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { ORG_ADDONS } from "@/lib/org-addons";
import { syncOrgAddonsForSubscription, syncSeatAddonsForSubscription } from "../billing-events";
import { MAX_EXTRA_ORGS, setExtraOrgs } from "../extra-orgs";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`org-addon-${uniq()}@test.local`}, 'Org Addon Owner', true) returning id`;
  return row!.id;
}

async function makeGroupOrg(
  planKey: "pro" | "pro_plus",
): Promise<{ orgId: string; walletId: string }> {
  const org = await createOrgForUser(await makeUser(), `Org Addon ${planKey} ${uniq()}`);
  await setOrgPlan(org.id, planKey);
  const walletId = await walletIdFor(org.id);
  return { orgId: org.id, walletId };
}

/** A group that looks BILLED: a live Stripe subscription id on the group row,
 *  and the payer gate stubbed to hand setExtraOrgs this exact group. */
async function makeBilledGroupOrg(
  planKey: "pro" | "pro_plus",
): Promise<{ orgId: string; walletId: string; stripeSubId: string }> {
  const { orgId, walletId } = await makeGroupOrg(planKey);
  const stripeSubId = `sub_stripe_${uniq()}`;
  await sql`
    update subscriptions set stripe_subscription_id = ${stripeSubId} where id = ${walletId}`;
  requireBillingOwnerMock.mockResolvedValue({ orgId, subscriptionId: walletId });
  return { orgId, walletId, stripeSubId };
}

/** An org-addon subscription item as the webhook sees it: the recurring SKU
 *  (matched by lookup_key), no target_org_id — group-wide by definition. */
function orgAddonItem(
  id: string,
  lookupKey: string,
  quantity: number,
  metadata: Record<string, string> = {},
): Stripe.SubscriptionItem {
  return {
    id,
    quantity,
    price: { id: `price_${id}`, lookup_key: lookupKey },
    metadata,
  } as unknown as Stripe.SubscriptionItem;
}

/** A SEAT item — a different add-on family riding the SAME subscription. */
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

let proBase: number;
let proPlusBase: number;
const proEntry = ORG_ADDONS.find((e) => e.planKey === "pro")!;
const proPlusEntry = ORG_ADDONS.find((e) => e.planKey === "pro_plus")!;

beforeAll(async () => {
  if (!HAS_DB) return;
  // Plan bases are READ, never hard-coded (V314 seeded pro 5 / pro_plus 10).
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements
     where feature_key = 'orgs.max_owned' and plan_key in ('pro', 'pro_plus')`;
  proBase = rows.find((r) => r.plan_key === "pro")?.int_value ?? 0;
  proPlusBase = rows.find((r) => r.plan_key === "pro_plus")?.int_value ?? 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("extra-org add-on — webhook sync -> resolver", () => {
  it("a pro org-addon item (qty=1) lifts orgs.max_owned by 1, group-wide", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
    expect(await groupOrgLimit(walletId)).toBe(proBase);

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 1)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);
    expect(await groupOrgLimit(walletId)).toBe(proBase + 1);

    // Group-wide by construction: target_org_id is NEVER set on an org-addon row.
    const [row] = await sql<{ target_org_id: string | null; feature_key: string }[]>`
      select target_org_id, feature_key from org_addons where wallet_id = ${walletId}`;
    expect(row?.target_org_id).toBeNull();
    expect(row?.feature_key).toBe("orgs.max_owned");
  });

  it("a pro_plus org-addon item prices/lifts independently of pro's", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro_plus");
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proPlusEntry.lookupKey, 2)]),
      walletId,
    );
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 2);
  });

  it("removal freezes the row (freeze-not-delete) and the cap drops back", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 1)]),
      walletId,
    );
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);

    await syncOrgAddonsForSubscription(subWith([]), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);

    const [row] = await sql<{ status: string; qty: number }[]>`
      select status, qty from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("canceled");
    // Freeze-not-delete keeps the history: the row is still there, qty intact.
    expect(row?.qty).toBe(1);
  });

  it("a quantity-0 item is a removal in disguise, never a qty=0 row (V324 CHECK)", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 1)]),
      walletId,
    );

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 0)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
    const [row] = await sql<{ status: string; qty: number }[]>`
      select status, qty from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("canceled");
    expect(row?.qty).toBe(1);
  });

  it("re-processing the SAME event is idempotent — one row, qty unchanged", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const sub = subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 3)]);

    await syncOrgAddonsForSubscription(sub, walletId);
    await syncOrgAddonsForSubscription(sub, walletId);

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 3);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(row?.n).toBe(1);
  });

  it("a quantity CHANGE updates the same row rather than adding a second", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 1)]),
      walletId,
    );
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 4)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 4);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(row?.n).toBe(1);
  });

  it("is GROUP-WIDE: a second org sharing the wallet also sees the raised cap", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const org2 = await createOrgForUser(await makeUser(), `Org Addon Sibling ${uniq()}`);
    await sql`update organizations set subscription_id = ${walletId} where id = ${org2.id}`;

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 1)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);
    expect(await getLimit(org2.id, "orgs.max_owned")).toBe(proBase + 1);
  });

  it("pins feature_key to orgs.max_owned even when item metadata says otherwise", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;
    // An org-addon SKU (matched by lookup_key) whose metadata names a DIFFERENT
    // cap. It lifts orgs.max_owned BY DEFINITION, so the rogue key must be
    // ignored — otherwise the row lands on a cap the orgs.max_owned-scoped
    // reconcile never cancels: a stuck lift.
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 1, { feature_key: "members.max" })]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);
    const [row] = await sql<{ feature_key: string }[]>`
      select feature_key from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.feature_key).toBe("orgs.max_owned");

    // …and a later removal still cancels it — proves it is not a stuck lift.
    await syncOrgAddonsForSubscription(subWith([]), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
  });
});

describe.skipIf(!HAS_DB)("extra-org add-on — never sweeps another add-on family", () => {
  it("removing every org add-on leaves the SEAT rows on the same wallet untouched", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const membersBase = (await getLimit(orgId, "members.max"))!;
    const seatItemId = `si_seat_${uniq()}`;
    const orgItemId = `si_org_${uniq()}`;

    // Both families ride the SAME subscription, as they do in production.
    const both = subWith([
      seatItem(seatItemId, orgId, 2),
      orgAddonItem(orgItemId, proEntry.lookupKey, 1),
    ]);
    await syncSeatAddonsForSubscription(both, walletId);
    await syncOrgAddonsForSubscription(both, walletId);
    expect(await getLimit(orgId, "members.max")).toBe(membersBase + 2);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);

    // The org add-on is dropped; the seat item stays on the subscription.
    const seatOnly = subWith([seatItem(seatItemId, orgId, 2)]);
    await syncSeatAddonsForSubscription(seatOnly, walletId);
    await syncOrgAddonsForSubscription(seatOnly, walletId);

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
    expect(await getLimit(orgId, "members.max")).toBe(membersBase + 2);
    const [seat] = await sql<{ status: string }[]>`
      select status from org_addons where stripe_item_id = ${seatItemId}`;
    expect(seat?.status).toBe("active");
  });

  it("an ADMIN-granted org row (null stripe_item_id) survives the reconcile", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    // SPEC-3: staff can comp extra orgs. status='granted', stripe_item_id NULL.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 2, 'granted')`;
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 2);

    // A purchase, then its removal: the Stripe row freezes, the grant does not.
    const itemId = `si_${uniq()}`;
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(itemId, proEntry.lookupKey, 1)]),
      walletId,
    );
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 3);

    await syncOrgAddonsForSubscription(subWith([]), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 2);
    const rows = await sql<{ status: string }[]>`
      select status from org_addons
       where wallet_id = ${walletId} and stripe_item_id is null`;
    expect(rows.map((r) => r.status)).toEqual(["granted"]);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — the PURCHASE usecase. setExtraOrgs mutates STRIPE ONLY; the webhook
// above stays the single writer of org_addons.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org purchase — setExtraOrgs mutates Stripe only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses a count outside 0..MAX with 400, before the payer gate or Stripe", async () => {
    await expect(setExtraOrgs(MAX_EXTRA_ORGS + 1)).rejects.toMatchObject({ status: 400 });
    await expect(setExtraOrgs(-1)).rejects.toMatchObject({ status: 400 });
    await expect(setExtraOrgs(1.5)).rejects.toMatchObject({ status: 400 });
    expect(requireBillingOwnerMock).not.toHaveBeenCalled();
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("refuses a community group (no live subscription) with 409, before any Stripe call", async () => {
    const org = await createOrgForUser(await makeUser(), `Org Addon Community ${uniq()}`);
    const walletId = await walletIdFor(org.id);
    requireBillingOwnerMock.mockResolvedValue({ orgId: org.id, subscriptionId: walletId });

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 409 });
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the group's plan has no add-on SKU, distinct from a bad count", async () => {
    // A LIVE Stripe subscription whose plan simply cannot buy extra orgs.
    const { orgId, walletId } = await makeGroupOrg("pro");
    await sql`
      update subscriptions
         set stripe_subscription_id = ${`sub_stripe_${uniq()}`}, plan_key = 'community'
       where id = ${walletId}`;
    requireBillingOwnerMock.mockResolvedValue({ orgId, subscriptionId: walletId });

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 409 });
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("creates a subscription item on the PLAN-SPECIFIC price, group-wide metadata only", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    const result = await setExtraOrgs(2);

    expect(result).toEqual({ subscriptionId: walletId, extraOrgs: 2 });
    expect(retrieveSpy).toHaveBeenCalledWith(stripeSubId);
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
    expect(itemCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: stripeSubId,
        price: "price_org_addon",
        quantity: 2,
        proration_behavior: "create_prorations",
        // Group-wide: NO target_org_id (unlike a seat item).
        metadata: { feature_key: "orgs.max_owned" },
      }),
    );
  });

  it("resolves the PRO PLUS price for a pro_plus group, not pro's", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    await setExtraOrgs(1);

    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proPlusEntry.lookupKey] }),
    );
    expect(pricesListSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
  });

  it("raising an existing item prorates now; lowering waits for renewal", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    const existing = { id: "si_existing", quantity: 2, price: { lookup_key: proEntry.lookupKey } };
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [existing] } });

    await setExtraOrgs(5);
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_existing", {
      quantity: 5,
      proration_behavior: "create_prorations",
    });

    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [existing] } });
    await setExtraOrgs(1);
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_existing", {
      quantity: 1,
      proration_behavior: "none",
    });
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("removal is a Stripe DELETE, proration_behavior none", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    const existing = { id: "si_existing", quantity: 3, price: { lookup_key: proEntry.lookupKey } };
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [existing] } });

    const result = await setExtraOrgs(0);

    expect(result).toEqual({ subscriptionId: walletId, extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith("si_existing", { proration_behavior: "none" });
  });

  it("removing when there is no item is a no-op, not a Stripe DELETE", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).not.toHaveBeenCalled();
  });

  it("writes NO org_addons row — the webhook is the single writer", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    await setExtraOrgs(3);

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(row?.n).toBe(0);
  });
});

describe("extra-org route auth (IDOR)", () => {
  it("a non-payer is refused 403 before any Stripe call", async () => {
    vi.clearAllMocks();
    requireBillingOwnerMock.mockRejectedValueOnce(
      new HttpError(403, "Only the person who pays for this billing group can manage its subscription."),
    );

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 403 });
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });
});

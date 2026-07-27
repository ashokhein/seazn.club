// v17 gap #293: the extra-organisation recurring add-on ($9/mo Pro, $19/mo
// Pro Plus -> +1 orgs.max_owned per unit, GROUP-WIDE). The webhook
// (syncOrgAddonsForSubscription) is the SINGLE writer of the org_addons row;
// these tests drive it against real Postgres and assert on the resolver
// (getLimit / groupOrgLimit), mirroring extra-seat-addon.test.ts.
//
// Task 3 adds the other half: the PURCHASE usecase (setExtraOrgs), which
// mutates Stripe ONLY, plus the >= 25 total-allowance staff alert.
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
  allowanceAlertSpy,
} = vi.hoisted(() => ({
  retrieveSpy: vi.fn(),
  itemCreateSpy: vi.fn(),
  itemUpdateSpy: vi.fn(),
  itemDelSpy: vi.fn(),
  pricesListSpy: vi.fn(async () => ({ data: [{ id: "price_org_addon" }] })),
  requireBillingOwnerMock: vi.fn(),
  allowanceAlertSpy: vi.fn(async () => true),
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
// Partial mock: billing-events.ts imports a dozen other senders from this
// module, so only the one under test is replaced.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendExtraOrgAllowanceAlertEmail: allowanceAlertSpy,
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
import {
  MAX_EXTRA_ORGS,
  ORG_ALLOWANCE_ALERT_THRESHOLD,
  maybeAlertOrgAllowance,
  setExtraOrgs,
  shouldAlertOnOrgAllowance,
} from "../extra-orgs";

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

/** Give the deferred() tail work room to run. Outside a Next request scope
 *  deferred() falls back to inline fire-and-forget, so the alert (an env
 *  check, one query, one send) settles on its own after setExtraOrgs resolves.
 *  Three real DB round trips of slack — the POSITIVE assertions use
 *  vi.waitFor and never depend on this; only the "did NOT alert" ones do. */
async function flushDeferred(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sql`select 1 as ok`;
  }
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

  // T1 review, CRITICAL. Recognition (isOrgAddonItem) normally goes through
  // price.lookup_key — but a drift replacement moves the key with Stripe's
  // `transfer_lookup_key`, so an item ALREADY riding a live subscription
  // starts reporting `price.lookup_key: null` and recognition falls entirely
  // to the metadata setExtraOrgs stamped at create time. T2's sweep cancels
  // every org-addon row whose item it no longer sees, so an unstamped item is
  // silently cancelled and a paying customer loses the cap.
  //
  // These two tests are deliberately end-to-end across the seam: the metadata
  // handed to the webhook is READ OFF the real create call rather than
  // hand-written, so dropping the stamp in the usecase turns the first one red
  // rather than leaving it asserting a copy of itself.
  it("stamps an item that T2 still recognises after transfer_lookup_key nulls its lookup_key", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });
    await setExtraOrgs(2);

    const created = itemCreateSpy.mock.calls[0]?.[0] as {
      quantity: number;
      metadata?: Record<string, string>;
    };
    const itemId = `si_${uniq()}`;
    const asWebhookSeesIt = (lookupKey: string | null) =>
      subWith([
        {
          id: itemId,
          quantity: created.quantity,
          price: { id: "price_org_addon", lookup_key: lookupKey },
          metadata: created.metadata ?? {},
        } as unknown as Stripe.SubscriptionItem,
      ]);

    // Before the replacement: matched on lookup_key, as usual.
    await syncOrgAddonsForSubscription(asWebhookSeesIt(proEntry.lookupKey), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 2);

    // After it: the key has moved to the replacement price, so this item's own
    // lookup_key is null and ONLY the stamp can identify it.
    await syncOrgAddonsForSubscription(asWebhookSeesIt(null), walletId);

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 2);
    const [row] = await sql<{ status: string }[]>`
      select status from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("active");
  });

  it("shows the hazard: an UNSTAMPED item is swept the moment its lookup_key goes null", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;
    const bare = (lookupKey: string | null) =>
      subWith([
        {
          id: itemId,
          quantity: 2,
          price: { id: "price_org_addon", lookup_key: lookupKey },
          metadata: {}, // what a create WITHOUT the stamp leaves behind
        } as unknown as Stripe.SubscriptionItem,
      ]);

    await syncOrgAddonsForSubscription(bare(proEntry.lookupKey), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 2);

    await syncOrgAddonsForSubscription(bare(null), walletId);

    // The customer is still being billed for this item; the cap is gone.
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
    const [row] = await sql<{ status: string }[]>`
      select status from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("canceled");
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

// ---------------------------------------------------------------------------
// Task 3 (owner-approved addition) — the >= 25 total-allowance staff alert.
// MAX_EXTRA_ORGS stays the self-serve cap: a purchase below it is NEVER
// blocked. Crossing 25 total organisations starts a SALES conversation while
// the customer is actively expanding, honouring V314:244-245's recorded intent
// ("an eleventh org becomes an enterprise conversation rather than a silent
// reseller") by ALERTING rather than BLOCKING.
// ---------------------------------------------------------------------------

describe("extra-org allowance alert — the pure trigger", () => {
  it("fires only when a PURCHASE lands the total allowance at or above the threshold", () => {
    const t = ORG_ALLOWANCE_ALERT_THRESHOLD;
    expect(t).toBe(25);
    // pro base 5 + 20 extras = 25.
    expect(shouldAlertOnOrgAllowance({ baseCap: 5, extraOrgs: 20, previousExtraOrgs: 19 })).toBe(true);
    expect(shouldAlertOnOrgAllowance({ baseCap: 5, extraOrgs: 19, previousExtraOrgs: 18 })).toBe(false);
    // pro_plus base 10 + 15 = 25: the threshold is on the TOTAL, so a bigger
    // base trips it with FEWER extras. A rule written against `extraOrgs`
    // alone would answer the same for both and is what this pins against.
    expect(shouldAlertOnOrgAllowance({ baseCap: 10, extraOrgs: 15, previousExtraOrgs: 0 })).toBe(true);
    expect(shouldAlertOnOrgAllowance({ baseCap: 10, extraOrgs: 14, previousExtraOrgs: 0 })).toBe(false);
  });

  it("never fires on a reduction or a no-op, even far above the threshold", () => {
    expect(shouldAlertOnOrgAllowance({ baseCap: 5, extraOrgs: 40, previousExtraOrgs: 45 })).toBe(false);
    expect(shouldAlertOnOrgAllowance({ baseCap: 5, extraOrgs: 40, previousExtraOrgs: 40 })).toBe(false);
    expect(shouldAlertOnOrgAllowance({ baseCap: 5, extraOrgs: 0, previousExtraOrgs: 40 })).toBe(false);
  });

  it("stays silent on an unlimited plan — there is no total to reach", () => {
    expect(shouldAlertOnOrgAllowance({ baseCap: null, extraOrgs: 50, previousExtraOrgs: 0 })).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("extra-org allowance alert — at purchase time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    allowanceAlertSpy.mockResolvedValue(true);
  });

  it("alerts staff when the purchase takes the group to the threshold, reading the base from plan_entitlements", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    const extras = ORG_ALLOWANCE_ALERT_THRESHOLD - proBase;
    await setExtraOrgs(extras);

    await vi.waitFor(() => expect(allowanceAlertSpy).toHaveBeenCalledTimes(1));
    expect(allowanceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@seazn.test",
        subscriptionId: walletId,
        orgId,
        planKey: "pro",
        baseCap: proBase,
        extraOrgs: extras,
        previousExtraOrgs: 0,
        totalAllowance: ORG_ALLOWANCE_ALERT_THRESHOLD,
        threshold: ORG_ALLOWANCE_ALERT_THRESHOLD,
      }),
    );
  });

  it("alerts a pro_plus group at FEWER extras — the threshold is the total, not the rider", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    await setExtraOrgs(ORG_ALLOWANCE_ALERT_THRESHOLD - proPlusBase);

    await vi.waitFor(() => expect(allowanceAlertSpy).toHaveBeenCalledTimes(1));
    expect(allowanceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ planKey: "pro_plus", baseCap: proPlusBase }),
    );
  });

  it("stays silent one organisation below the threshold — the purchase is never blocked either", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    const result = await setExtraOrgs(ORG_ALLOWANCE_ALERT_THRESHOLD - proBase - 1);

    expect(result.extraOrgs).toBe(ORG_ALLOWANCE_ALERT_THRESHOLD - proBase - 1);
    await flushDeferred();
    expect(allowanceAlertSpy).not.toHaveBeenCalled();
  });

  it("stays silent when STAFF_ALERT_EMAIL is unset, however large the purchase", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    await setExtraOrgs(MAX_EXTRA_ORGS);

    await flushDeferred();
    expect(allowanceAlertSpy).not.toHaveBeenCalled();
  });

  it("stays silent when the change LOWERS the count, even above the threshold", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({
      id: stripeSubId,
      items: { data: [{ id: "si_big", quantity: 40, price: { lookup_key: proEntry.lookupKey } }] },
    });

    await setExtraOrgs(30); // total 35, still far above 25 — but a REDUCTION.

    await flushDeferred();
    expect(allowanceAlertSpy).not.toHaveBeenCalled();
  });

  it("still buys the organisations when the alert send blows up — MAX_EXTRA_ORGS is the only bound", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    allowanceAlertSpy.mockRejectedValue(new Error("resend is down"));
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValueOnce({ id: stripeSubId, items: { data: [] } });

    const result = await setExtraOrgs(MAX_EXTRA_ORGS);

    expect(result.extraOrgs).toBe(MAX_EXTRA_ORGS);
    expect(itemCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: MAX_EXTRA_ORGS }),
    );
    await vi.waitFor(() => expect(allowanceAlertSpy).toHaveBeenCalled());
    await flushDeferred();
  });

  it("maybeAlertOrgAllowance resolves rather than throwing when the send throws", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    allowanceAlertSpy.mockRejectedValue(new Error("resend is down"));
    const { orgId, walletId } = await makeGroupOrg("pro");

    // Called directly, NOT through deferred()'s swallow: this is what proves
    // the alert itself is wrapped, rather than only its caller.
    await expect(
      maybeAlertOrgAllowance({
        subscriptionId: walletId,
        orgId,
        planKey: "pro",
        extraOrgs: MAX_EXTRA_ORGS,
        previousExtraOrgs: 0,
      }),
    ).resolves.toBeUndefined();
    expect(allowanceAlertSpy).toHaveBeenCalled();
  });

  it("maybeAlertOrgAllowance resolves when the base-cap lookup finds no plan row", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { orgId, walletId } = await makeGroupOrg("pro");

    await expect(
      maybeAlertOrgAllowance({
        subscriptionId: walletId,
        orgId,
        planKey: `no_such_plan_${uniq()}`,
        extraOrgs: MAX_EXTRA_ORGS,
        previousExtraOrgs: 0,
      }),
    ).resolves.toBeUndefined();
    await flushDeferred();
    expect(allowanceAlertSpy).not.toHaveBeenCalled();
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

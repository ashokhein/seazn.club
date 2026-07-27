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
import { detachOrgFromGroup } from "../billing-groups";
import { POST } from "@/app/api/billing/extra-orgs/route";
import {
  MAX_EXTRA_ORGS,
  ORG_ALLOWANCE_ALERT_THRESHOLD,
  extraOrgsInUse,
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

/** Pad a billing group out to a given size. Bare rows on purpose: the usage
 *  floor counts ORGANISATIONS IN THE GROUP, so what matters is the row and its
 *  `subscription_id`, not who owns it. (An org with no owner member also
 *  cannot be detached, which is what makes the detach test below pick a real
 *  owned org instead.) */
async function addFillerOrgs(walletId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      insert into organizations (name, slug, subscription_id)
      values (${`Filler ${uniq()}`}, ${`filler-${uniq()}-${i}`}, ${walletId})`;
  }
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

  // 422, NOT 400. requireBillingOwner raises 400 for "No active organization"
  // and "No billing account for the selected organization", both reachable
  // from a stale org cookie — so a shared 400 would tell someone to fix a
  // number when the real remedy is reselecting an organisation.
  it("refuses a count outside 0..MAX with 422, before the payer gate or Stripe", async () => {
    await expect(setExtraOrgs(MAX_EXTRA_ORGS + 1)).rejects.toMatchObject({ status: 422 });
    await expect(setExtraOrgs(-1)).rejects.toMatchObject({ status: 422 });
    await expect(setExtraOrgs(1.5)).rejects.toMatchObject({ status: 422 });
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

// ---------------------------------------------------------------------------
// Task 3 (owner-approved addition) — the usage floor.
//
// Caps in this codebase are ADMISSION-ONLY: assertMayOwnAnotherOrg and
// assertWithinGroupCap both check `count + 1 > limit` on the way IN and are
// never re-evaluated against organisations that already exist (T2's
// investigation, report §5). So without this guard the add-on is optional
// after month one: buy it, create org #11, cancel it — the cap falls back to
// 10, org #11 keeps working for ever, the group keeps paying 11 seats and
// stops paying the $9/$19 rider. That IS the "silent reseller" case
// V314__billing_groups.sql:244-245 was written about.
//
// The fix refuses only REDUCTIONS below current usage. There is no org
// deletion anywhere in the product (no deleteOrg; /api/orgs/[id] has PATCH
// only), so detach is the ONLY exit — which is why the floor counts orgs in
// the GROUP, not orgs a user owns. Count the wrong thing and the customer pays
// for ever with no way out, so the detach-then-reduce test below drives the
// REAL detachOrgFromGroup usecase rather than describing it.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org usage floor — you cannot cancel what you are using", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /** A pro_plus group holding `total` live orgs, with `extras` purchased
   *  riders already on its Stripe subscription. Pro Plus (base 10) keeps the
   *  fixture small: 11 orgs is one over the base. */
  async function groupInUse(total: number, extras: number) {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    await addFillerOrgs(walletId, total - 1);
    const addonItem = {
      id: "si_addon",
      quantity: extras,
      price: { id: "price_addon", lookup_key: proPlusEntry.lookupKey },
    };
    // items.data[0] is the PLAN item, as it is in production — syncGroupQuantity
    // reads that one, setExtraOrgs finds the add-on by lookup_key.
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          {
            id: "si_plan",
            quantity: total,
            price: { id: "price_plan", billing_scheme: "tiered", lookup_key: "seazn_pro_plus_monthly" },
          },
          ...(extras > 0 ? [addonItem] : []),
        ],
      },
    });
    return { orgId, walletId, stripeSubId };
  }

  it("refuses to reduce below the organisations the group is actually using", async () => {
    // 11 live orgs on a base of 10: exactly one org is standing on the rider.
    const { walletId } = await groupInUse(proPlusBase + 1, 1);
    expect(await extraOrgsInUse(walletId, "pro_plus")).toBe(1);

    await expect(setExtraOrgs(0)).rejects.toMatchObject({ status: 423 });

    // The add-on is untouched — the leak is that this DELETE used to go through.
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("allows a reduction to exactly what is in use (the boundary, not one past it)", async () => {
    const { walletId } = await groupInUse(proPlusBase + 1, 2);
    expect(await extraOrgsInUse(walletId, "pro_plus")).toBe(1);

    const result = await setExtraOrgs(1);

    expect(result.extraOrgs).toBe(1);
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_addon", {
      quantity: 1,
      proration_behavior: "none",
    });
  });

  it("increases are never refused, however many organisations the group holds", async () => {
    await groupInUse(proPlusBase + 1, 1);

    await expect(setExtraOrgs(5)).resolves.toMatchObject({ extraOrgs: 5 });
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_addon", {
      quantity: 5,
      proration_behavior: "create_prorations",
    });
  });

  it("DETACH THEN REDUCE: the real exit works, so nobody is trapped paying for ever", async () => {
    const { walletId, stripeSubId } = await groupInUse(proPlusBase, 1);
    // A twelfth… eleventh org, owned by a real user so it can be detached
    // (filler orgs have no owner member and detach refuses those on purpose).
    const leaverOwner = await makeUser();
    const leaver = await createOrgForUser(leaverOwner, `Org Addon Leaver ${uniq()}`);
    await sql`update organizations set subscription_id = ${walletId} where id = ${leaver.id}`;
    expect(await extraOrgsInUse(walletId, "pro_plus")).toBe(1);
    await expect(setExtraOrgs(0)).rejects.toMatchObject({ status: 423 });

    // The documented way out — the real usecase, not a hand-written UPDATE.
    await detachOrgFromGroup({ actorUserId: leaverOwner, orgId: leaver.id, mode: "release" });

    // The group is back inside its plan's own cap, so the rider is now
    // genuinely optional and cancelling it is allowed.
    expect(await extraOrgsInUse(walletId, "pro_plus")).toBe(0);
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          {
            id: "si_plan",
            quantity: proPlusBase,
            price: { id: "price_plan", billing_scheme: "tiered", lookup_key: "seazn_pro_plus_monthly" },
          },
          { id: "si_addon", quantity: 1, price: { id: "price_addon", lookup_key: proPlusEntry.lookupKey } },
        ],
      },
    });

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith("si_addon", { proration_behavior: "none" });
  });

  it("an ADMIN-COMPED rider is not counted as usage — a comped group is never forced to buy", async () => {
    const { walletId } = await groupInUse(proPlusBase + 1, 0);
    // SPEC-3 staff comp: status='granted', no stripe_item_id. It is what is
    // holding org #11 up, so it must lower the floor, or this group is told to
    // buy a rider for capacity it was given.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 1, 'granted')`;

    expect(await extraOrgsInUse(walletId, "pro_plus")).toBe(0);
    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
  });

  it("never traps a group whose plan has no orgs.max_owned row at all", async () => {
    // Unknown base => no floor. Refusing on the basis of a cap we cannot read
    // would be the one unrecoverable outcome, so this fails OPEN.
    const { walletId } = await groupInUse(proPlusBase + 1, 1);
    expect(await extraOrgsInUse(walletId, `no_such_plan_${uniq()}`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review findings A and B — the two ways the "one item, right price"
// assumption breaks in production.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org item reconciliation — tier changes and duplicates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const planItem = {
    id: "si_plan",
    quantity: 1,
    price: { id: "price_plan", billing_scheme: "tiered", lookup_key: "seazn_plan_monthly" },
  };
  const addonItem = (id: string, lookupKey: string, quantity: number) => ({
    id,
    quantity,
    price: { id: `price_${id}`, lookup_key: lookupKey },
  });

  // FINDING A. isOrgAddonItem matches BOTH tiers' lookup keys, so an item
  // bought on Pro is still "an org add-on" after the group upgrades to Pro
  // Plus. Reusing it would bill $9 per extra for ever on a $19 plan — the
  // exact "Pro + extras undercuts Pro Plus" arbitrage the two rates exist to
  // close, reached by upgrading rather than by staying put.
  it("re-prices when the group upgraded Pro -> Pro Plus: the $9 item is replaced, not reused", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: { data: [planItem, addonItem("si_old_pro", proEntry.lookupKey, 2)] },
    });

    await setExtraOrgs(3);

    expect(itemDelSpy).toHaveBeenCalledWith("si_old_pro", {
      proration_behavior: "create_prorations",
    });
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proPlusEntry.lookupKey] }),
    );
    expect(itemCreateSpy).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }));
    // The bug was that this branch ran instead, keeping the old rate for ever.
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("re-prices the mirror case Pro Plus -> Pro, so a downgrade stops overcharging", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: { data: [planItem, addonItem("si_old_plus", proPlusEntry.lookupKey, 1)] },
    });

    await setExtraOrgs(1);

    expect(itemDelSpy).toHaveBeenCalledWith("si_old_plus", {
      proration_behavior: "create_prorations",
    });
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
    expect(itemCreateSpy).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("leaves a correctly-priced item alone — re-pricing must not churn the normal case", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: { data: [planItem, addonItem("si_ok", proEntry.lookupKey, 1)] },
    });

    await setExtraOrgs(2);

    expect(itemUpdateSpy).toHaveBeenCalledWith("si_ok", {
      quantity: 2,
      proration_behavior: "create_prorations",
    });
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  // FINDING B. Two concurrent calls both see an empty item list and both
  // create. A `find` then sees only the first.
  it("cancelling removes EVERY duplicate — none is left billing invisibly", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          planItem,
          addonItem("si_dup_a", proEntry.lookupKey, 1),
          addonItem("si_dup_b", proEntry.lookupKey, 1),
        ],
      },
    });

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });

    expect(itemDelSpy).toHaveBeenCalledWith("si_dup_a", { proration_behavior: "none" });
    expect(itemDelSpy).toHaveBeenCalledWith("si_dup_b", { proration_behavior: "none" });
    expect(itemDelSpy).toHaveBeenCalledTimes(2);
  });

  it("consolidates duplicates onto one item rather than stranding the second", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          planItem,
          addonItem("si_dup_a", proEntry.lookupKey, 2),
          addonItem("si_dup_b", proEntry.lookupKey, 3),
        ],
      },
    });

    await setExtraOrgs(4);

    expect(itemDelSpy).toHaveBeenCalledWith("si_dup_b", {
      proration_behavior: "create_prorations",
    });
    // 5 were billed, 4 are wanted: a reduction from the customer's side, so no
    // mid-cycle charge on the survivor.
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_dup_a", {
      quantity: 4,
      proration_behavior: "none",
    });
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("counts duplicates TOGETHER, so the >= 25 alert cannot be dodged by a stranded item", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.test");
    const { stripeSubId } = await makeBilledGroupOrg("pro");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          planItem,
          addonItem("si_dup_a", proEntry.lookupKey, 10),
          addonItem("si_dup_b", proEntry.lookupKey, 9),
        ],
      },
    });

    await setExtraOrgs(20);

    await vi.waitFor(() => expect(allowanceAlertSpy).toHaveBeenCalledTimes(1));
    expect(allowanceAlertSpy).toHaveBeenCalledWith(
      // 19 previously billed across two items, not the 10 a `find` would see.
      expect.objectContaining({ previousExtraOrgs: 19, extraOrgs: 20, totalAllowance: proBase + 20 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Review finding C — 400 is reserved for org/session state, so the route must
// never emit one for a malformed body.
// ---------------------------------------------------------------------------

describe("extra-org route — a 400 from this endpoint always means org state", () => {
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost/api/billing/extra-orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers 422, not 400, when count is the wrong type", async () => {
    expect((await post({ count: "three" })).status).toBe(422);
  });

  it("answers 422, not 400, for an unknown field (strict schema)", async () => {
    expect((await post({ count: 1, orgId: "sneaky" })).status).toBe(422);
  });

  it("answers 422 for a count past MAX_EXTRA_ORGS, with the bound owned by the usecase", async () => {
    expect((await post({ count: MAX_EXTRA_ORGS + 1 })).status).toBe(422);
    expect(requireBillingOwnerMock).not.toHaveBeenCalled();
  });

  it("still surfaces the payer gate's own 403", async () => {
    requireBillingOwnerMock.mockRejectedValueOnce(new HttpError(403, "nope"));
    expect((await post({ count: 1 })).status).toBe(403);
  });
});

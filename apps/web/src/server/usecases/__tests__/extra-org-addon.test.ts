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
  // Typed with the resolver's args so a test can answer PER LOOKUP KEY (Task 4b
  // needs pro and pro_plus to resolve to different live price ids); the default
  // implementation ignores them.
  pricesListSpy: vi.fn<
    (args: { lookup_keys: string[]; limit?: number }) => Promise<{ data: { id: string }[] }>
  >(async () => ({ data: [{ id: "price_org_addon" }] })),
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
import {
  convergeOrgAddonPrices,
  processStripeEvent,
  syncOrgAddonsForSubscription,
  syncSeatAddonsForSubscription,
} from "../billing-events";
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

// ---------------------------------------------------------------------------
// Re-review RF1 — a staff override REPLACES the plan base (resolve() returns
// `int_value: ov.int_value`, not a coalesce), and groupOrgLimit resolves the
// group cap through a representative member org. So an override IS the
// group's effective base, and reading plan_entitlements instead turns the
// cancel guard from a leak-stopper into a TRAP — aimed squarely at the >= 25
// population the alert exists to court, where an override is the natural
// staff remedy.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org usage floor — a staff override is the base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("counts an override as capacity, so a comped group can cancel riders it does not need", async () => {
    // A Pro group (plan base 5) grown to 20 organisations on a staff override
    // of 50 — the exact enterprise shape #293's >= 25 alert is meant to create.
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 19);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'orgs.max_owned', 50)`;

    // 50 covers all 20 organisations, so NOTHING is standing on a rider.
    // Against plan_entitlements this read 20 - 5 = 15 and refused.
    expect(await extraOrgsInUse(walletId, "pro")).toBe(0);

    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 20, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_addon", quantity: 3, price: { id: "price_addon", lookup_key: proEntry.lookupKey } },
        ],
      },
    });

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith("si_addon", { proration_behavior: "none" });
  });

  it("still holds the floor when the override is SMALLER than the organisations in use", async () => {
    // An override of 6 on a group of 8: two organisations are genuinely
    // standing on purchased riders, so the guard must still bite. Proves the
    // fix reads the override rather than merely ignoring the base.
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 7);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'orgs.max_owned', 6)`;

    expect(await extraOrgsInUse(walletId, "pro")).toBe(2);

    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 8, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_addon", quantity: 2, price: { id: "price_addon", lookup_key: proEntry.lookupKey } },
        ],
      },
    });

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 423 });
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("an EXPIRED override does not count — the resolver ignores it, so must the floor", async () => {
    const { orgId, walletId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 7);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, expires_at)
      values (${orgId}, 'orgs.max_owned', 50, now() - interval '1 day')`;

    // Back to the plan base of 5: 8 orgs - 5 = 3 riders genuinely in use.
    expect(await extraOrgsInUse(walletId, "pro")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Re-review RF2 — the delete loop is destructive and ran BEFORE the price
// resolve, so a tier change against an unsynced catalog deleted the working
// rider and THEN threw 503.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org tier change — an unsynced catalog must not destroy the rider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    pricesListSpy.mockResolvedValue({ data: [{ id: "price_org_addon" }] });
  });

  it("refuses 503 WITHOUT deleting the item it could not replace", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    // The group upgraded, so the Pro-priced item is not the survivor and must
    // be swapped — but the replacement price does not exist in this account.
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 1, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_old_pro", quantity: 2, price: { id: "price_old", lookup_key: proEntry.lookupKey } },
        ],
      },
    });
    pricesListSpy.mockResolvedValue({ data: [] });

    await expect(setExtraOrgs(2)).rejects.toMatchObject({ status: 503 });

    // The whole point: the customer still has the rider that worked.
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("resolves the price BEFORE deleting, so the swap order is resolve -> delete -> create", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 1, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_old_pro", quantity: 2, price: { id: "price_old", lookup_key: proEntry.lookupKey } },
        ],
      },
    });

    await setExtraOrgs(2);

    expect(pricesListSpy.mock.invocationCallOrder[0]).toBeLessThan(
      itemDelSpy.mock.invocationCallOrder[0]!,
    );
    expect(itemDelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      itemCreateSpy.mock.invocationCallOrder[0]!,
    );
  });
});

// ---------------------------------------------------------------------------
// Re-review RF3 — `await req.json()` throws SyntaxError on a truncated body,
// which failed the `instanceof ZodError` test and reached handler's unknown
// branch: a 500 plus a Sentry capture, i.e. junk input could page someone.
// ---------------------------------------------------------------------------

describe("extra-org route — junk input must never page anyone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const rawPost = (body: string) =>
    POST(
      new Request("http://localhost/api/billing/extra-orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

  it("answers 422, not 500, for a truncated JSON body", async () => {
    const res = await rawPost('{"count": 1');
    expect(res.status).toBe(422);
  });

  it("answers 422, not 500, for a body that is not JSON at all", async () => {
    expect((await rawPost("not json")).status).toBe(422);
  });

  it("answers 422, not 500, for an empty body", async () => {
    expect((await rawPost("")).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Task 4b — the PASSIVE half of re-pricing. Task 3 made a PURCHASE re-price;
// a plan change is not a purchase. A group that upgrades pro -> pro_plus never
// calls setExtraOrgs, and syncOrgAddonsForSubscription reconciles ROWS only —
// it never looks at an item's price. So the rider stayed on the old rate for
// ever: an upgraded Pro Plus group kept paying $9/rider (the arbitrage the two
// rates exist to close) and a downgraded Pro group kept paying $19.
//
// The fix lives in the WEBHOOK because that is the one convergence point for
// an in-app change, a Dashboard edit and a Portal change alike.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org rider prices converge on a PLAN change (webhook)", () => {
  /** The live price id `stripe:sync` would resolve for a lookup key. Distinct
   *  from the id an item is CARRYING, which is the whole point of the test. */
  const livePriceFor = (lookupKey: string) => `price_live_${lookupKey}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Resolve by lookup key, so pro and pro_plus resolve to DIFFERENT ids.
    pricesListSpy.mockImplementation(async (args: { lookup_keys: string[] }) => ({
      data: [{ id: livePriceFor(args.lookup_keys[0]!) }],
    }));
    // The in-place update returns the item as it now stands. Mirrors Stripe:
    // the id survives, the price moves, the quantity is whatever was sent.
    itemUpdateSpy.mockImplementation(
      async (id: string, params: { price: string; quantity: number }) => ({
        id,
        quantity: params.quantity,
        price: { id: params.price, lookup_key: null },
        metadata: { feature_key: "orgs.max_owned" },
      }),
    );
  });

  /** A rider item as the webhook sees it. `priceId` defaults to the live price
   *  for that lookup key (i.e. already converged); pass one explicitly to model
   *  an item stranded on another tier's price, or on a superseded one. */
  const riderItem = (
    id: string,
    lookupKey: string,
    quantity: number,
    priceId: string = livePriceFor(lookupKey),
  ) =>
    ({
      id,
      quantity,
      price: { id: priceId, lookup_key: lookupKey },
      metadata: { feature_key: "orgs.max_owned" },
    }) as unknown as Stripe.SubscriptionItem;

  const planItem = {
    id: "si_plan",
    quantity: 1,
    price: { id: "price_plan", lookup_key: "seazn_plan_monthly" },
  } as unknown as Stripe.SubscriptionItem;

  const subFor = (stripeSubId: string, items: Stripe.SubscriptionItem[]) =>
    ({ id: stripeSubId, items: { data: items } }) as unknown as Stripe.Subscription;

  /** A `customer.subscription.updated` event for a group, so the ORDER of
   *  converge vs row-sync is exercised through the real handler rather than
   *  asserted on a function called in isolation. No `org_id`: that would drag
   *  the pass-credit usecase in, which this behaviour has nothing to do with.
   *  The plan item deliberately carries NO price, so syncSubscriptionForGroup
   *  keeps the plan already on the row (its documented unknown-price rule) —
   *  which is exactly the post-plan-change state: row on the new tier, rider
   *  item still on the old tier's price. */
  const updatedEvent = (
    stripeSubId: string,
    walletId: string,
    items: Stripe.SubscriptionItem[],
  ): Stripe.Event =>
    ({
      id: `evt_${uniq()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: stripeSubId,
          status: "active",
          customer: `cus_${uniq()}`,
          trial_end: null,
          cancel_at_period_end: false,
          metadata: { subscription_id: walletId },
          items: { data: [{ id: "si_plan", quantity: 1 }, ...items] },
        },
      },
    }) as unknown as Stripe.Event;

  it("pro -> pro_plus: the $9 rider is re-priced, keeping its item id, qty and cap", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    // The state right after an upgrade: the group row says pro_plus, the rider
    // item is still on the Pro price it was bought at.
    const stranded = riderItem("si_rider", proEntry.lookupKey, 3);
    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stranded]));

    // Moved onto the CURRENT plan's price…
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_rider", {
      price: livePriceFor(proPlusEntry.lookupKey),
      // NOT optional: Stripe resets quantity to 1 on a price change unless it
      // is restated (billing/subscriptions/change-price). Omitting it would cut
      // a 3-rider group to 1 and revoke two organisations of paid capacity.
      quantity: 3,
      proration_behavior: "create_prorations",
    });
    // …never deleted and re-created, so the row keyed on the item id survives.
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();

    const rows = await sql<{ stripe_item_id: string; qty: number; status: string }[]>`
      select stripe_item_id, qty, status from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stripe_item_id).toBe("si_rider");
    expect(rows[0]!.qty).toBe(3);
    expect(rows[0]!.status).toBe("active");
    // A re-price is a RATE change, never a capacity change.
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 3);
    expect(await groupOrgLimit(walletId)).toBe(proPlusBase + 3);
  });

  it("pro_plus -> pro: re-prices the overcharge direction too", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [planItem, riderItem("si_rider", proPlusEntry.lookupKey, 2)]),
      walletId,
    );
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
    expect(itemUpdateSpy).toHaveBeenCalledWith("si_rider", {
      price: livePriceFor(proEntry.lookupKey),
      quantity: 2,
      proration_behavior: "create_prorations",
    });
  });

  it("a superseded price object (lookup_key transferred away) is moved to the live one", async () => {
    // transfer_lookup_key leaves the OLD price reporting lookup_key: null, so a
    // lookup-key comparison cannot tell this from "wrong tier". Comparing price
    // IDS answers both the same way — move to the price the catalog resolves.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    const superseded = {
      id: "si_rider",
      quantity: 1,
      price: { id: "price_superseded", lookup_key: null },
      metadata: { feature_key: "orgs.max_owned" },
    } as unknown as Stripe.SubscriptionItem;

    await convergeOrgAddonPrices(subFor(stripeSubId, [planItem, superseded]), walletId);

    expect(itemUpdateSpy).toHaveBeenCalledWith("si_rider", {
      price: livePriceFor(proEntry.lookupKey),
      quantity: 1,
      proration_behavior: "create_prorations",
    });
  });

  it("an already-correct price is NOT written — this is what stops it churning every event", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [planItem, riderItem("si_rider", proEntry.lookupKey, 4)]),
      walletId,
    );
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("CONVERGES, does not loop: the event our own update produces writes nothing", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const items = [planItem, riderItem("si_rider", proEntry.lookupKey, 2)];
    const sub = subFor(stripeSubId, items);

    await convergeOrgAddonPrices(sub, walletId);
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);

    // Stripe now emits a SECOND customer.subscription.updated describing the
    // item as we left it. Feed exactly that back in — the payload converge
    // itself rewrote, which is the same object Stripe would send.
    vi.clearAllMocks();
    await convergeOrgAddonPrices(sub, walletId);
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("spends NO Stripe round trip when the subscription carries no rider at all", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await convergeOrgAddonPrices(subFor(stripeSubId, [planItem]), walletId);
    // Every subscription.updated for every group we bill runs this; the vast
    // majority carry no rider, and none of them may become a prices.list.
    expect(pricesListSpy).not.toHaveBeenCalled();
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("a plan with no rider SKU does nothing — no write, no throw, no noise, rows still sync", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await setOrgPlan(orgId, "community");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(
      updatedEvent(stripeSubId, walletId, [riderItem("si_rider", proEntry.lookupKey, 1)]),
    );

    // No price to move to, and cancelling from inside a webhook is the cancel
    // paths' call, not this one's.
    expect(pricesListSpy).not.toHaveBeenCalled();
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(itemDelSpy).not.toHaveBeenCalled();
    // Recognised and skipped, NOT tripped over: without the orgAddonForPlan
    // guard this reaches resolveOrgAddonPriceId, which 400s on a plan with no
    // SKU, and every community group with a legacy rider logs an error on
    // every subscription event for the rest of time.
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    const [row] = await sql<{ qty: number; status: string }[]>`
      select qty, status from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'`;
    expect(row).toMatchObject({ qty: 1, status: "active" });
  });

  it("an unsynced catalog is LOGGED, never thrown — the row sync still runs", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    pricesListSpy.mockResolvedValue({ data: [] }); // resolveOrgAddonPriceId 503s
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // A throw here would fail the whole webhook, which Stripe retries for ever
    // and which would skip every handler after it — including the row sync the
    // resolver actually reads.
    await expect(
      processStripeEvent(
        updatedEvent(stripeSubId, walletId, [riderItem("si_rider", proEntry.lookupKey, 2)]),
      ),
    ).resolves.toBeUndefined();

    expect(itemUpdateSpy).not.toHaveBeenCalled();
    // Actionable identifiers, not just "something failed".
    const messages = logged.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(walletId) && m.includes(stripeSubId))).toBe(true);
    logged.mockRestore();

    // The rows reconciled anyway: only the RATE is stale.
    const [row] = await sql<{ stripe_item_id: string; qty: number; status: string }[]>`
      select stripe_item_id, qty, status from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'`;
    expect(row).toMatchObject({ stripe_item_id: "si_rider", qty: 2, status: "active" });
  });

  it("a failing Stripe update is LOGGED, never thrown — the row sync still runs", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    itemUpdateSpy.mockRejectedValue(new Error("stripe is having a day"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processStripeEvent(
        updatedEvent(stripeSubId, walletId, [riderItem("si_rider", proEntry.lookupKey, 2)]),
      ),
    ).resolves.toBeUndefined();

    const messages = logged.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("si_rider"))).toBe(true);
    logged.mockRestore();

    const [row] = await sql<{ qty: number; status: string }[]>`
      select qty, status from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'`;
    expect(row).toMatchObject({ qty: 2, status: "active" });
  });

  it("never touches the plan item or a seat item", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [
        planItem,
        seatItem("si_seat", orgId, 5),
        riderItem("si_rider", proEntry.lookupKey, 1),
      ]),
      walletId,
    );
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy.mock.calls[0]![0]).toBe("si_rider");
  });

  it("claims the target price once: a duplicate rider is left for setExtraOrgs to consolidate", async () => {
    // Duplicates are reachable (two concurrent creates), and Stripe will not
    // hold two items on one subscription at the same price — so re-pricing BOTH
    // would fail the second call for nothing. Tidying the shape is the purchase
    // path's job; the webhook's job is that the RATE is right.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [
        planItem,
        riderItem("si_dup_a", proEntry.lookupKey, 1),
        riderItem("si_dup_b", proEntry.lookupKey, 1),
      ]),
      walletId,
    );
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy.mock.calls[0]![0]).toBe("si_dup_a");
    expect(logged.mock.calls.some((c) => String(c[0]).includes("si_dup_b"))).toBe(true);
    logged.mockRestore();
  });

  it("converges BEFORE the row sync, so the sync never reconciles a payload we invalidated", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const event = updatedEvent(stripeSubId, walletId, [
      riderItem("si_rider", proEntry.lookupKey, 2),
    ]);
    await processStripeEvent(event);

    // The handler hands the ROW SYNC the post-update item, not the one the
    // event arrived carrying.
    const items = (event.data.object as Stripe.Subscription).items.data;
    const rider = items.find((it) => it.id === "si_rider")!;
    expect(rider.price.id).toBe(livePriceFor(proPlusEntry.lookupKey));
    expect(rider.quantity).toBe(2);
  });
});

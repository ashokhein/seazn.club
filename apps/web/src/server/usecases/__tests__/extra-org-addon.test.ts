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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  itemRetrieveSpy,
  repriceAlertSpy,
} = vi.hoisted(() => ({
  retrieveSpy: vi.fn(),
  itemCreateSpy: vi.fn(),
  itemUpdateSpy: vi.fn(),
  itemDelSpy: vi.fn(),
  // Task 4b: converge re-reads the ITEM live before mutating it, so the
  // quantity it writes back can never come from a stale event snapshot.
  itemRetrieveSpy: vi.fn(),
  repriceAlertSpy: vi.fn(async () => true),
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
    subscriptionItems: {
      create: itemCreateSpy,
      update: itemUpdateSpy,
      del: itemDelSpy,
      retrieve: itemRetrieveSpy,
    },
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
  sendExtraOrgRepriceFailedAlertEmail: repriceAlertSpy,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { groupOrgLimit } from "@/lib/billing-group";
import { HttpError } from "@/lib/errors";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { ORG_ADDONS } from "@/lib/org-addons";
import {
  convergeOrgAddonPrices,
  maybeAlertOrgRepriceFailed,
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
/** What the resolver DEGRADES to — dunning, an incomplete first payment and a
 *  suspended org all read this plan. The floor must never. */
let communityBase: number;
const proEntry = ORG_ADDONS.find((e) => e.planKey === "pro")!;
const proPlusEntry = ORG_ADDONS.find((e) => e.planKey === "pro_plus")!;

beforeAll(async () => {
  if (!HAS_DB) return;
  // Plan bases are READ, never hard-coded (V314 seeded pro 5 / pro_plus 10).
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements
     where feature_key = 'orgs.max_owned' and plan_key in ('pro', 'pro_plus', 'community')`;
  proBase = rows.find((r) => r.plan_key === "pro")?.int_value ?? 0;
  proPlusBase = rows.find((r) => r.plan_key === "pro_plus")?.int_value ?? 0;
  communityBase = rows.find((r) => r.plan_key === "community")?.int_value ?? 0;
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
   *  riders already on its Stripe subscription AND in `org_addons`. Pro Plus
   *  (base 10) keeps the fixture small: 11 orgs is one over the base.
   *
   *  The DB row is not decoration. The floor is
   *  `totalBonus - grantedBonus` — purchased capacity, with admin comps taken
   *  out — and with no ACTIVE row on the wallet both terms are 0 whatever the
   *  status sets say. Widening the granted set to `["granted", "active"]`
   *  (which subtracts the very riders the floor measures, and reopens the
   *  silent-reseller leak this whole guard exists to close) left the suite
   *  fully green until this row existed.
   *
   *  Column for column what the webhook writes — the single writer of
   *  Stripe-paid rows (billing-events.ts, `ORG_ADDON_FEATURE_KEY` /
   *  `ORG_ADDON_DELTA_EACH`, `target_org_id` null, status 'active'). */
  async function groupInUse(total: number, extras: number) {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    await addFillerOrgs(walletId, total - 1);
    // V324's unique index is on `stripe_item_id` ALONE, so a literal reused
    // across tests does not collide loudly — it MOVES the previous test's row
    // onto this wallet. Unique per fixture call, and the same id in Stripe and
    // in the database, which is the pairing production maintains.
    const addonItemId = `si_addon_${uniq()}`;
    if (extras > 0) {
      await sql`
        insert into org_addons
          (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
           stripe_item_id, status)
        values (${walletId}, null, null, 'orgs.max_owned', 1, ${extras},
                ${addonItemId}, 'active')`;
    }
    const addonItem = {
      id: addonItemId,
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
    return { orgId, walletId, stripeSubId, addonItemId };
  }

  it("refuses to reduce below the organisations the group is actually using", async () => {
    // 11 live orgs on a base of 10: exactly one org is standing on the rider,
    // and that rider is an ACTIVE org_addons row, as it is in production.
    const { walletId } = await groupInUse(proPlusBase + 1, 1);
    expect(await extraOrgsInUse(walletId, "pro_plus", 1)).toBe(1);

    await expect(setExtraOrgs(0)).rejects.toMatchObject({ status: 423 });

    // The add-on is untouched — the leak is that this DELETE used to go through.
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("counts a PURCHASED rider as capacity in use, not as capacity granted", async () => {
    // The arithmetic the floor is: purchased = totalBonus - grantedBonus. The
    // sibling comp test proves a 'granted' row lowers the floor; this proves an
    // 'active' one does NOT. Without both, widening the granted status set to
    // include 'active' subtracts every purchased rider, the floor collapses to
    // 0, and "buy, create org #11, cancel, keep it for ever" is back.
    const { walletId } = await groupInUse(proPlusBase + 1, 1);
    const [row] = await sql<{ qty: number; status: string }[]>`
      select qty, status from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'`;
    expect(row).toMatchObject({ qty: 1, status: "active" });
    expect(await extraOrgsInUse(walletId, "pro_plus", 1)).toBe(1);
  });

  it("allows a reduction to exactly what is in use (the boundary, not one past it)", async () => {
    const { walletId, addonItemId } = await groupInUse(proPlusBase + 1, 2);
    expect(await extraOrgsInUse(walletId, "pro_plus", 2)).toBe(1);

    const result = await setExtraOrgs(1);

    expect(result.extraOrgs).toBe(1);
    expect(itemUpdateSpy).toHaveBeenCalledWith(addonItemId, {
      quantity: 1,
      proration_behavior: "none",
    });
  });

  it("increases are never refused, however many organisations the group holds", async () => {
    const { addonItemId } = await groupInUse(proPlusBase + 1, 1);

    await expect(setExtraOrgs(5)).resolves.toMatchObject({ extraOrgs: 5 });
    expect(itemUpdateSpy).toHaveBeenCalledWith(addonItemId, {
      quantity: 5,
      proration_behavior: "create_prorations",
    });
  });

  it("DETACH THEN REDUCE: the real exit works, so nobody is trapped paying for ever", async () => {
    const { walletId, stripeSubId, addonItemId } = await groupInUse(proPlusBase, 1);
    // A twelfth… eleventh org, owned by a real user so it can be detached
    // (filler orgs have no owner member and detach refuses those on purpose).
    const leaverOwner = await makeUser();
    const leaver = await createOrgForUser(leaverOwner, `Org Addon Leaver ${uniq()}`);
    await sql`update organizations set subscription_id = ${walletId} where id = ${leaver.id}`;
    expect(await extraOrgsInUse(walletId, "pro_plus", 1)).toBe(1);
    await expect(setExtraOrgs(0)).rejects.toMatchObject({ status: 423 });

    // The documented way out — the real usecase, not a hand-written UPDATE.
    await detachOrgFromGroup({ actorUserId: leaverOwner, orgId: leaver.id, mode: "release" });

    // The group is back inside its plan's own cap, so the rider is now
    // genuinely optional and cancelling it is allowed.
    expect(await extraOrgsInUse(walletId, "pro_plus", 1)).toBe(0);
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          {
            id: "si_plan",
            quantity: proPlusBase,
            price: { id: "price_plan", billing_scheme: "tiered", lookup_key: "seazn_pro_plus_monthly" },
          },
          { id: addonItemId, quantity: 1, price: { id: "price_addon", lookup_key: proPlusEntry.lookupKey } },
        ],
      },
    });

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith(addonItemId, { proration_behavior: "none" });
  });

  it("an ADMIN-COMPED rider is not counted as usage — a comped group is never forced to buy", async () => {
    // 11 orgs on a base of 10, ONE purchased rider and one staff comp. The
    // purchased rider matters: with none, the clamp would answer 0 whatever the
    // comp arithmetic did, and this test would prove nothing.
    const { walletId, addonItemId } = await groupInUse(proPlusBase + 1, 1);
    // SPEC-3 staff comp: status='granted', no stripe_item_id. It is what is
    // holding org #11 up, so it must lower the floor, or this group is told to
    // buy a rider for capacity it was given.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 1, 'granted')`;

    // Without the comp this is 1; the comp is the only reason it is 0.
    expect(await extraOrgsInUse(walletId, "pro_plus", 1)).toBe(0);
    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith(addonItemId, { proration_behavior: "none" });
  });

  it("never traps a group whose plan has no orgs.max_owned row at all", async () => {
    // Unknown base => no floor. Refusing on the basis of a cap we cannot read
    // would be the one unrecoverable outcome, so this fails OPEN.
    const { walletId } = await groupInUse(proPlusBase + 1, 1);
    expect(await extraOrgsInUse(walletId, `no_such_plan_${uniq()}`, 1)).toBe(0);
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
    expect(await extraOrgsInUse(walletId, "pro", 3)).toBe(0);

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
    // fix READS the override rather than merely ignoring the base.
    //
    // FOUR riders purchased, not two, deliberately: at two the clamp would cap
    // the answer at 2 and the plan base of 5 (raw floor 3) would give the same
    // 2, so the test could not tell the override from the plan. At four,
    // override-6 answers 2 and plan-5 answers 3.
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 7);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'orgs.max_owned', 6)`;

    expect(await extraOrgsInUse(walletId, "pro", 4)).toBe(2);

    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 8, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_addon", quantity: 4, price: { id: "price_addon", lookup_key: proEntry.lookupKey } },
        ],
      },
    });

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 423 });
    expect(itemUpdateSpy).not.toHaveBeenCalled();
  });

  it("reads expires_at BOTH ways: the same override counts when live and not when expired", async () => {
    // Round 4 shipped this as an expired-only assertion, and 8 - 5 = 3 came out
    // the same under the implementation it was meant to guard AND the one it
    // replaced — it carried no regression weight at all. Driving the SAME row
    // through both states is what discriminates: an implementation that ignores
    // overrides fails the live half, and one that ignores expiry fails the
    // expired half. Neither can be reached by accident.
    const { orgId, walletId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 7);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, expires_at)
      values (${orgId}, 'orgs.max_owned', 50, now() - interval '1 day')`;

    // Expired => dead, exactly as resolve() treats it. Back to the plan base of
    // 5: 8 orgs - 5 = 3 riders genuinely in use.
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(3);

    // The one and only change: push the SAME row's expiry into the future.
    await sql`
      update org_entitlement_overrides set expires_at = now() + interval '30 days'
       where org_id = ${orgId} and feature_key = 'orgs.max_owned'`;

    // 50 now covers all 8, so nothing stands on a rider.
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-5 CRITICAL — round 4 derived the floor from `groupOrgLimit`, which
// resolves through `resolve()`. `hasLiveSubscription` ADMITS `past_due` and
// `incomplete` (lib/subscription-status.ts), while `resolve()` collapses both
// to `community` (lib/entitlements.ts). So the floor was computed against the
// DEGRADED base rather than the plan the customer is paying for, and a customer
// in dunning trying to cancel the rider they can no longer afford was refused
// 423 and told to move an organisation out — when the remedy is to pay the
// invoice. Deriving from the resolver re-created the very trap round 4 removed,
// one layer down.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org usage floor — dunning must not invent riders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /** A Pro group of `liveOrgs` organisations with `riders` purchased add-on
   *  ROWS in the DB (what the webhook writes) and a matching Stripe item. */
  async function proGroupWithRiders(liveOrgs: number, riders: number) {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, liveOrgs - 1);
    if (riders > 0) {
      await sql`
        insert into org_addons
          (wallet_id, target_org_id, feature_key, delta_each, qty, status, stripe_item_id)
        values (${walletId}, null, 'orgs.max_owned', 1, ${riders}, 'active', ${`si_${uniq()}`})`;
    }
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: liveOrgs, price: { id: "price_plan", billing_scheme: "tiered" } },
          ...(riders > 0
            ? [
                {
                  id: "si_addon",
                  quantity: riders,
                  price: { id: "price_addon", lookup_key: proEntry.lookupKey },
                },
              ]
            : []),
        ],
      },
    });
    return { orgId, walletId, stripeSubId };
  }

  it("a PAST_DUE group beyond the grace window is not billed a floor it never bought", async () => {
    // Exactly the measured case: Pro, 5 live orgs (= the plan base), 2 riders.
    const { orgId, walletId } = await proGroupWithRiders(proBase, 2);
    await sql`
      update subscriptions
         set status = 'past_due', status_changed_at = now() - interval '30 days'
       where id = ${walletId}`;
    await invalidateOrgEntitlements(orgId);

    // POSITIVE DISCRIMINATOR (this suite's absence-assertions can pass against
    // their own hole otherwise): prove the resolver really IS degraded here, so
    // a floor of 0 below cannot be passing merely because nothing degraded.
    // Healthy this is proBase + 2; in dunning it reads the COMMUNITY base.
    expect(await groupOrgLimit(walletId)).toBe(communityBase + 2);

    // Nothing stands on a rider: 5 organisations, a base of 5. Round 4 read the
    // degraded cap and answered 4 — four riders that were never purchased.
    expect(await extraOrgsInUse(walletId, "pro", 2)).toBe(0);
  });

  it("an INCOMPLETE subscription — a first payment that never landed — does not raise it either", async () => {
    // `incomplete` gets no grace at all (#206/#223-B), so it degrades at once.
    const { orgId, walletId } = await proGroupWithRiders(proBase, 2);
    await sql`update subscriptions set status = 'incomplete' where id = ${walletId}`;
    await invalidateOrgEntitlements(orgId);

    expect(await groupOrgLimit(walletId)).toBe(communityBase + 2);
    expect(await extraOrgsInUse(walletId, "pro", 2)).toBe(0);
  });

  it("a group in dunning can still CANCEL the rider it can no longer afford", async () => {
    // The end-to-end shape of the trap. Round 4 answered 423 here, telling a
    // customer to move an organisation out when the remedy is the invoice.
    const { orgId, walletId } = await proGroupWithRiders(proBase, 2);
    await sql`
      update subscriptions
         set status = 'past_due', status_changed_at = now() - interval '30 days'
       where id = ${walletId}`;
    await invalidateOrgEntitlements(orgId);

    await expect(setExtraOrgs(0)).resolves.toMatchObject({ extraOrgs: 0 });
    expect(itemDelSpy).toHaveBeenCalledWith("si_addon", { proration_behavior: "none" });
  });

  // NOTE for the next reader: a suspended-org case was drafted here and
  // DELIBERATELY NOT SHIPPED. resolve() degrades a suspended org to community
  // too, so it looks like the same bug — but `groupCapResolvingOrg` prefers a
  // non-suspended org and `groupOrgLimit`'s degenerate branch reads
  // plan_entitlements directly, so suspension could not reach the floor even
  // before this fix. The test passed against the implementation it was meant to
  // catch, i.e. it carried no regression weight, so it is a comment instead.
});

// ---------------------------------------------------------------------------
// Round-5 CRITICAL, second half — `floor > previousExtraOrgs` is incoherent by
// construction: you cannot stand on more riders than you purchased. Its absence
// is what let the dunning bug ship, so it gets its own pin. It is reachable
// with nothing broken at all: caps are ADMISSION-ONLY, so a plan downgrade
// leaves a group holding more organisations than its total capacity and the raw
// arithmetic blames the whole overhang on riders.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org usage floor — it can never quote unpurchased riders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  async function overCapProGroup(liveOrgs: number, riders: number) {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, liveOrgs - 1);
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: liveOrgs, price: { id: "price_plan", billing_scheme: "tiered" } },
          ...(riders > 0
            ? [
                {
                  id: "si_addon",
                  quantity: riders,
                  price: { id: "price_addon", lookup_key: proEntry.lookupKey },
                },
              ]
            : []),
        ],
      },
    });
    return { walletId, stripeSubId };
  }

  it("an over-cap group is quoted its RIDERS, not its overhang", async () => {
    // 9 organisations on a Pro base of 5 with a single rider — total capacity
    // 6, so three organisations are over-cap. The raw arithmetic says 4.
    const { walletId } = await overCapProGroup(proBase + 4, 1);
    expect(await extraOrgsInUse(walletId, "pro", 1)).toBe(1);
  });

  it("a group that purchased NOTHING has no floor, whatever its overhang", async () => {
    const { walletId } = await overCapProGroup(proBase + 4, 0);
    expect(await extraOrgsInUse(walletId, "pro", 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-5 MINOR — the added-back sum omitted the scope predicates of the very
// function it inverts (`addonBonusForWallet`: `target_org_id is null or = the
// representative org`, `target_competition_id is null`). It now runs the SAME
// statement, narrowed to 'granted', so the two cannot diverge again.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org usage floor — comps count only where they apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /** 8 organisations on a Pro base of 5, with 5 riders billed so the clamp
   *  never masks the arithmetic. Baseline floor is 3. */
  async function group8() {
    const { orgId, walletId } = await makeBilledGroupOrg("pro");
    await addFillerOrgs(walletId, 7);
    return { orgId, walletId };
  }

  const grant = (walletId: string, targetOrg: string | null, targetComp: string | null, qty: number) =>
    sql`insert into org_addons
          (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty, status)
        values (${walletId}, ${targetOrg}, ${targetComp}, 'orgs.max_owned', 1, ${qty}, 'granted')`;

  it("baseline: no comp, so the plan base alone sets the floor", async () => {
    const { walletId } = await group8();
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(3);
  });

  it("a GROUP-WIDE comp lowers the floor", async () => {
    const { walletId } = await group8();
    await grant(walletId, null, null, 2);
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(1);
  });

  it("a comp targeted AT the representative org lowers it too (the `or =` half)", async () => {
    const { orgId, walletId } = await group8();
    await grant(walletId, orgId, null, 2);
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(1);
  });

  it("a comp granted to ANOTHER organisation does not lower this group's floor", async () => {
    const { walletId } = await group8();
    const { orgId: strangerId } = await makeGroupOrg("pro");
    await grant(walletId, strangerId, null, 2);
    // Still 3. Without the target_org_id predicate this read 1.
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(3);
  });

  it("a COMPETITION-scoped comp does not lower an org-level cap", async () => {
    const { walletId } = await group8();
    await grant(walletId, null, randomUUID(), 2);
    expect(await extraOrgsInUse(walletId, "pro", 5)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Round-5 — the delete-then-create window, PINNED AS IT STANDS TODAY. RF2 moved
// the price resolve above the delete loop, which closed the 503 half; the
// `create` call itself is still outside any transaction Stripe can offer, so a
// create that fails after a successful delete strands the customer with no
// rider. The report deferred the real fix (a single
// `subscriptions.update({ items: [...] })`) but left it with NO red to turn
// green. This is that red: when the items[] rewrite lands,
// `subscriptionItems.del` stops being called and this test fails, which is
// exactly the signal the follow-up needs.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("extra-org tier swap — today's non-atomic window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    pricesListSpy.mockResolvedValue({ data: [{ id: "price_org_addon" }] });
  });

  it("a create that fails AFTER the delete leaves the group with no rider (follow-up: items[])", async () => {
    const { stripeSubId } = await makeBilledGroupOrg("pro_plus");
    // Upgraded group still carrying the Pro-priced rider: a swap, not an update.
    retrieveSpy.mockResolvedValue({
      id: stripeSubId,
      items: {
        data: [
          { id: "si_plan", quantity: 1, price: { id: "price_plan", billing_scheme: "tiered" } },
          { id: "si_old_pro", quantity: 2, price: { id: "price_old", lookup_key: proEntry.lookupKey } },
        ],
      },
    });
    itemCreateSpy.mockRejectedValueOnce(new Error("stripe_down"));

    await expect(setExtraOrgs(2)).rejects.toThrow(/stripe_down/);

    // TODAY'S BEHAVIOUR, not the desired one: the working rider is already
    // gone, its replacement never landed, and the error reaches the caller as a
    // 500. The customer has lost capacity they were paying for until they retry.
    expect(itemDelSpy).toHaveBeenCalledWith("si_old_pro", {
      proration_behavior: "create_prorations",
    });
    expect(itemCreateSpy).toHaveBeenCalledTimes(1);
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

  /** Subscription-item ids, UNIQUE PER TEST. `org_addons`' V324 unique index is
   *  on `stripe_item_id` ALONE (feature-key and wallet agnostic), so a literal
   *  id reused between tests does not insert a second row — it UPSERTS the
   *  previous test's row onto this test's wallet. Assertions scoped by wallet
   *  still pass, which is what hides it; an assertion like "the row does not
   *  exist yet" instead reads another test's leftovers and fails for a reason
   *  that has nothing to do with the code. */
  let riderId: string;
  let dupA: string;
  let dupB: string;
  let seatId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    riderId = `si_rider_${uniq()}`;
    dupA = `si_dup_a_${uniq()}`;
    dupB = `si_dup_b_${uniq()}`;
    seatId = `si_seat_${uniq()}`;
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
    // LIVE Stripe by default agrees with whatever the payload said — tests that
    // care about staleness override this per test.
    itemRetrieveSpy.mockImplementation(async (id: string) => liveItems[id] ?? null);
    liveItems = {};
    repriceAlertSpy.mockResolvedValue(true);
    // Every alert in this codebase is gated on STAFF_ALERT_EMAIL first, so
    // without this the alert assertions would pass vacuously.
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@test.local");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** What Stripe would return from `subscriptionItems.retrieve`, keyed by item
   *  id. `riderItem` registers the item here as it builds it, so LIVE agrees
   *  with the payload by default; a test models a STALE payload by mutating the
   *  entry afterwards. That asymmetry is the point — the payload is a snapshot,
   *  Stripe is the truth. */
  let liveItems: Record<string, unknown> = {};

  /** A rider item as the webhook sees it, also registered as its live Stripe
   *  state. `priceId` defaults to the live price for that lookup key (i.e.
   *  already converged); pass one explicitly to model an item stranded on
   *  another tier's price, or on a superseded one. */
  const riderItem = (
    id: string,
    lookupKey: string,
    quantity: number,
    priceId: string = livePriceFor(lookupKey),
  ) => {
    const item = {
      id,
      quantity,
      price: { id: priceId, lookup_key: lookupKey },
      metadata: { feature_key: "orgs.max_owned" },
    };
    liveItems[id] = { ...item, price: { ...item.price } };
    return item as unknown as Stripe.SubscriptionItem;
  };

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
    const stranded = riderItem(riderId, proEntry.lookupKey, 3);
    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stranded]));

    // Moved onto the CURRENT plan's price…
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy).toHaveBeenCalledWith(riderId, {
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
    expect(rows[0]!.stripe_item_id).toBe(riderId);
    expect(rows[0]!.qty).toBe(3);
    expect(rows[0]!.status).toBe("active");
    // A re-price is a RATE change, never a capacity change.
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 3);
    expect(await groupOrgLimit(walletId)).toBe(proPlusBase + 3);
  });

  it("pro_plus -> pro: re-prices the overcharge direction too", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [planItem, riderItem(riderId, proPlusEntry.lookupKey, 2)]),
      walletId,
    );
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
    expect(itemUpdateSpy).toHaveBeenCalledWith(riderId, {
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
      id: riderId,
      quantity: 1,
      price: { id: "price_superseded", lookup_key: null },
      metadata: { feature_key: "orgs.max_owned" },
    } as unknown as Stripe.SubscriptionItem;

    await convergeOrgAddonPrices(subFor(stripeSubId, [planItem, superseded]), walletId);

    expect(itemUpdateSpy).toHaveBeenCalledWith(riderId, {
      price: livePriceFor(proEntry.lookupKey),
      quantity: 1,
      proration_behavior: "create_prorations",
    });
  });

  it("an already-correct price is NOT written — this is what stops it churning every event", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro");
    await convergeOrgAddonPrices(
      subFor(stripeSubId, [planItem, riderItem(riderId, proEntry.lookupKey, 4)]),
      walletId,
    );
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(itemDelSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });

  it("CONVERGES, does not loop: the event our own update produces writes nothing", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const items = [planItem, riderItem(riderId, proEntry.lookupKey, 2)];
    const sub = subFor(stripeSubId, items);

    await convergeOrgAddonPrices(sub, walletId);
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);

    // Stripe now emits a SECOND customer.subscription.updated describing the
    // item as we left it. Feed exactly that back in — the payload converge
    // itself rewrote, which is the same object Stripe would send.
    //
    // Note the re-priced item reports `lookup_key: null` (see the itemUpdate
    // mock): that is the post-drift-replacement shape, and it is the shape that
    // makes this test DISCRIMINATE. Comparing lookup keys, the settled item
    // reads as "not the current tier" for ever, and every subsequent event
    // tries to move it again — a handler that oscillates on its own output.
    // Comparing price IDS, it reads as settled. Hence the silence assertion:
    // "no update call" alone is satisfied by the duplicate guard refusing the
    // write, which is a different reason and one that logs.
    vi.clearAllMocks();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await convergeOrgAddonPrices(sub, walletId);
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
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
      updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 1)]),
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
        updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
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
    expect(row).toMatchObject({ stripe_item_id: riderId, qty: 2, status: "active" });
  });

  it("a failing Stripe update is LOGGED, never thrown — the row sync still runs", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    itemUpdateSpy.mockRejectedValue(new Error("stripe is having a day"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processStripeEvent(
        updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
      ),
    ).resolves.toBeUndefined();

    const messages = logged.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(riderId))).toBe(true);
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
        seatItem(seatId, orgId, 5),
        riderItem(riderId, proEntry.lookupKey, 1),
      ]),
      walletId,
    );
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy.mock.calls[0]![0]).toBe(riderId);
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
        riderItem(dupA, proEntry.lookupKey, 1),
        riderItem(dupB, proEntry.lookupKey, 1),
      ]),
      walletId,
    );
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy.mock.calls[0]![0]).toBe(dupA);
    expect(logged.mock.calls.some((c) => String(c[0]).includes(dupB))).toBe(true);
    logged.mockRestore();
    // …and the loser is ALERTED, not just logged: it bills the wrong rate until
    // a human or a purchase consolidates it, and nothing here retries.
    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: dupB, expectedPriceId: livePriceFor(proPlusEntry.lookupKey) }),
    );
  });

  // Renamed from "converges BEFORE the row sync": mutating the payload holds
  // at ANY call order, so the old name promised an ordering guarantee this
  // assertion never made. It pins the PAYLOAD REWRITE; the test after it pins
  // the order.
  it("rewrites the event payload with the post-update item, so no stale item reaches the sync", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const event = updatedEvent(stripeSubId, walletId, [
      riderItem(riderId, proEntry.lookupKey, 2),
    ]);
    await processStripeEvent(event);

    const items = (event.data.object as Stripe.Subscription).items.data;
    const rider = items.find((it) => it.id === riderId)!;
    expect(rider.price.id).toBe(livePriceFor(proPlusEntry.lookupKey));
    expect(rider.quantity).toBe(2);
  });

  it("runs the re-price BEFORE the row sync — observed from the DB at update time", async () => {
    // The order is asserted from OBSERVABLE STATE rather than from the payload:
    // at the moment the Stripe update fires, the org_addons row must not exist
    // yet, because the row sync has not run. Swap the two calls in
    // handleSubscriptionChanged and the row is already there — which is the
    // reversal this test exists to catch, and which mutating the payload
    // (the test above) cannot see at all.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    let rowExistedAtUpdateTime: boolean | null = null;
    itemUpdateSpy.mockImplementation(
      async (id: string, params: { price: string; quantity: number }) => {
        const [seen] = await sql<{ one: number }[]>`
          select 1 as one from org_addons where stripe_item_id = ${id}`;
        rowExistedAtUpdateTime = !!seen;
        return {
          id,
          quantity: params.quantity,
          price: { id: params.price, lookup_key: null },
          metadata: { feature_key: "orgs.max_owned" },
        };
      },
    );

    await processStripeEvent(
      updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
    );

    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(rowExistedAtUpdateTime).toBe(false);
    // And the sync did run afterwards, so this is "before", not "instead of".
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.qty).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Review fix round 1 — the quantity written back to Stripe must be LIVE.
  // Webhook deliveries are not ordered and runEvent's lease dedupes only the
  // same event, so an older `updated` can be processed after a newer purchase.
  // Trusting the payload's quantity would revoke paid capacity in STRIPE, which
  // is authoritative — unlike a stale row, which the next event repairs.
  // -------------------------------------------------------------------------

  it("STALE EVENT: re-reads the live quantity, so an out-of-order delivery cannot shrink the rider", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    // E1: the upgrade event, emitted when the group held 2 riders.
    const stale = riderItem(riderId, proEntry.lookupKey, 2);
    // E2 already happened: the customer bought 3 more, so Stripe holds 5 — and
    // on a price the event has never seen, which is what lets the success log
    // below be checked for WHICH price it reports.
    liveItems[riderId] = {
      ...(liveItems[riderId] as object),
      quantity: 5,
      price: { id: "price_stripe_actually_holds", lookup_key: proEntry.lookupKey },
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stale]));

    // The success log names the price STRIPE held, not the payload's, for the
    // same reason the failure alert does: a responder reading "re-priced from
    // X" must be able to trust X.
    expect(warned.mock.calls.some((c) => String(c[0]).includes("price_stripe_actually_holds"))).toBe(
      true,
    );
    warned.mockRestore();

    expect(itemRetrieveSpy).toHaveBeenCalledWith(riderId);
    // 5, never the payload's 2. Sending 2 would revoke three organisations of
    // paid capacity — and because Stripe is authoritative, nothing would undo it.
    expect(itemUpdateSpy).toHaveBeenCalledWith(riderId, {
      price: livePriceFor(proPlusEntry.lookupKey),
      quantity: 5,
      proration_behavior: "create_prorations",
    });
    // …and the row the sync then writes carries the live quantity too, so the
    // cap matches what the customer is actually paying for.
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.qty).toBe(5);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 5);
  });

  it("STALE EVENT: a rider already converged by a newer delivery is left alone — AND the row follows Stripe", async () => {
    // Driven through processStripeEvent, not convergeOrgAddonPrices directly:
    // calling converge alone never runs the row sync, and the row is exactly
    // where this branch used to go wrong. `setExtraOrgs` sells AND re-prices in
    // one go (Task 3), so "someone got there first" means Stripe holds a NEW
    // quantity as well as the new price — and the event still says the old one.
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const stale = riderItem(riderId, proEntry.lookupKey, 2);
    liveItems[riderId] = {
      ...(liveItems[riderId] as object),
      quantity: 5,
      price: { id: livePriceFor(proPlusEntry.lookupKey), lookup_key: proPlusEntry.lookupKey },
    };

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stale]));

    // Nothing to write to Stripe: the price is already right.
    expect(itemRetrieveSpy).toHaveBeenCalledWith(riderId);
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(repriceAlertSpy).not.toHaveBeenCalled();

    // But the ROW must follow Stripe, not the stale event. Writing 2 here bills
    // the customer for 5 riders and entitles them to 2 — and nothing repairs
    // it, because convergence only fires on a plan change and #332's sweep does
    // not exist yet.
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.qty).toBe(5);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 5);
  });

  // Round 3: the publish moved to the READ, so EVERY exit after it leaves the
  // row sync looking at live Stripe state. These two pin the exits that were
  // still handing on the stale payload after round 2 — the property is now
  // structural, and an exit added later inherits it rather than having to
  // remember it.

  it("STALE EVENT: a REJECTED update still leaves the row on the live quantity", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const stale = riderItem(riderId, proEntry.lookupKey, 2);
    liveItems[riderId] = { ...(liveItems[riderId] as object), quantity: 5 };
    // The currency class this suite already covers: Stripe refuses the swap.
    itemUpdateSpy.mockRejectedValue(
      Object.assign(new Error("subscription is in currency usd"), {
        code: "price_currency_mismatch",
      }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stale]));
    logged.mockRestore();

    // The RATE stays wrong — that is what the alert is for. The CAP must not
    // also go wrong: `live` was in hand (it is three lines from the alert's own
    // currentPriceId) and was being dropped for `quantity`, so the row was
    // written 2 against Stripe's 5 — the identical failure round 2 fixed on the
    // converged exit, surviving here.
    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.qty).toBe(5);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 5);
  });

  it("STALE EVENT: a rider Stripe has already emptied is CANCELED, not left billing a cap", async () => {
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    // Two events, because freeze-not-delete needs a row to freeze. First the
    // rider exists and is correctly priced, so the row is written the ordinary
    // way and the cap goes up.
    await processStripeEvent(
      updatedEvent(stripeSubId, walletId, [riderItem(riderId, proPlusEntry.lookupKey, 2)]),
    );
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 2);

    // Now a STALE delivery: the event still remembers 2 riders on the old Pro
    // price, but Stripe has since been emptied to 0. The mismatched price is
    // what carries it past the steady-state exit and into the live read.
    vi.clearAllMocks();
    const stale = riderItem(riderId, proEntry.lookupKey, 2);
    liveItems[riderId] = { ...(liveItems[riderId] as object), quantity: 0 };

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [stale]));

    // Nothing to re-price on the way out…
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    // …but the row must follow Stripe to zero. Trusting the payload kept it
    // { qty: 2, active } and left the group holding two organisations of
    // capacity nobody is paying for — this issue's own leak direction.
    const [row] = await sql<{ qty: number; status: string }[]>`
      select qty, status from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.status).toBe("canceled");
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase);
  });

  it("STALE EVENT: the DUPLICATE that loses the claim still gets its row from Stripe", async () => {
    // Round 4: the third pre-read exit. The duplicate check used to sit with the
    // payload-trust skips, so the loser `continue`d before the live read and its
    // row was written from the event snapshot — the same leak as the two exits
    // closed in round 3. It now sits after the read and the publish, which costs
    // nothing extra: this branch only runs for duplicates, is already inside the
    // round trips, and already alerts.
    const { orgId, walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const winner = riderItem(dupA, proEntry.lookupKey, 1);
    const loser = riderItem(dupB, proEntry.lookupKey, 2);
    // Stripe holds 7 on the loser, on a price the event has never seen — so the
    // alert and the log can be checked for WHICH price they report.
    liveItems[dupB] = {
      ...(liveItems[dupB] as object),
      quantity: 7,
      price: { id: "price_loser_actually_on", lookup_key: proEntry.lookupKey },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [winner, loser]));

    // Both the alert and the log name what Stripe holds, not the payload's
    // price — this is the field a responder acts on.
    expect(logged.mock.calls.some((c) => String(c[0]).includes("price_loser_actually_on"))).toBe(
      true,
    );
    logged.mockRestore();

    // The winner converges; the loser is alerted, not written to Stripe.
    expect(itemUpdateSpy).toHaveBeenCalledTimes(1);
    expect(itemUpdateSpy.mock.calls[0]![0]).toBe(dupA);
    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: dupB, currentPriceId: "price_loser_actually_on" }),
    );

    // …and the loser's ROW follows Stripe. Writing 2 here would hand the group
    // five organisations of capacity nobody is paying for.
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${dupB}`;
    expect(row?.qty).toBe(7);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 1 + 7);
  });

  // Round 5: the CLAIM itself was uncovered. Every test above drove
  // `targetClaimed` through the post-update assignment, so the opening scan,
  // the quantity-0 clause in it, and the converged branch's assignment were all
  // free to be deleted with the suite green. These three pin them. They need
  // three fixtures rather than one because the four ways the claim can be taken
  // have mutually exclusive preconditions — see each test's comment.

  it("an already-correct rider HOLDS the claim, even at quantity 0, so a sibling is never sent into a rejected update", async () => {
    // Pins the OPENING SCAN and its deliberate inclusion of quantity-0 items.
    // A is on the target price at qty 0 — which still occupies that price in
    // Stripe — and takes the steady-state exit, which never sets the claim. So
    // the scan is the only thing that records it.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const a = riderItem(dupA, proPlusEntry.lookupKey, 0);
    const b = riderItem(dupB, proEntry.lookupKey, 2);
    liveItems[dupB] = { ...(liveItems[dupB] as object), quantity: 9 };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [a, b]));
    logged.mockRestore();

    // Without the claim, B is sent into an update onto a price Stripe already
    // holds; Stripe rejects it, and a well-understood duplicate becomes a
    // spurious "Stripe rejected the item update" page. Fail-safe, but wrong.
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: dupB }));
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${dupB}`;
    expect(row?.qty).toBe(9);
  });

  it("a rider Stripe has ALREADY moved onto the target claims it — the claim answers to live state", async () => {
    // Pins the CONVERGED BRANCH's `targetClaimed = true`. Neither payload names
    // the target, so the opening scan claims nothing and only the live read can
    // discover that A is already there. This is the benefit round 4 advertised
    // in a comment and left unpinned.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const a = riderItem(dupA, proEntry.lookupKey, 1);
    const b = riderItem(dupB, proEntry.lookupKey, 3);
    liveItems[dupA] = {
      ...(liveItems[dupA] as object),
      price: { id: livePriceFor(proPlusEntry.lookupKey), lookup_key: proPlusEntry.lookupKey },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [a, b]));
    logged.mockRestore();

    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: dupB }));
  });

  it("a rider that IS on the target is never alerted as a duplicate, however the claim was taken", async () => {
    // Pins the ORDER of the converged check against the duplicate check. The
    // payload claims the target for A, but A has since moved off it and B is
    // the item Stripe now has on it. A stale claim must not turn B — precisely
    // the item that is already correct — into a duplicate alert.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const a = riderItem(dupA, proPlusEntry.lookupKey, 1);
    const b = riderItem(dupB, proEntry.lookupKey, 4);
    liveItems[dupA] = {
      ...(liveItems[dupA] as object),
      price: { id: "price_a_moved_away", lookup_key: proEntry.lookupKey },
    };
    liveItems[dupB] = {
      ...(liveItems[dupB] as object),
      price: { id: livePriceFor(proPlusEntry.lookupKey), lookup_key: proPlusEntry.lookupKey },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(updatedEvent(stripeSubId, walletId, [a, b]));
    logged.mockRestore();

    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(repriceAlertSpy).not.toHaveBeenCalled();
    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${dupB}`;
    expect(row?.qty).toBe(4);
  });

  it("an item deleted between emission and processing is a benign race, not an alert", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const item = riderItem(riderId, proEntry.lookupKey, 2);
    const gone = Object.assign(new Error("No such subscription item"), {
      code: "resource_missing",
    });
    itemRetrieveSpy.mockRejectedValue(gone);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await convergeOrgAddonPrices(subFor(stripeSubId, [planItem, item]), walletId);

    expect(itemUpdateSpy).not.toHaveBeenCalled();
    // There is nothing left to re-price, so paging a human would be noise.
    expect(logged).not.toHaveBeenCalled();
    expect(repriceAlertSpy).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Review fix round 1 — a failed convergence must be OBSERVABLE. There is no
  // retry and no sweep (#332), and this runs only on subscription.updated, so a
  // group that never changes plan again never re-converges. A log nobody reads
  // is not a safety net for the load-bearing $9/$19 split.
  // -------------------------------------------------------------------------

  it("ALERTS staff when the catalog cannot name a price, with the identifiers to act on", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    pricesListSpy.mockResolvedValue({ data: [] }); // stripe:sync never run here
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(
      updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
    );
    logged.mockRestore();

    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@test.local",
        subscriptionId: walletId,
        stripeSubscriptionId: stripeSubId,
        // The plan is KNOWN here — resolveOrgAddonPriceId throws after the plan
        // row has been read — and it is what tells a responder whether to
        // expect the $9 or the $19 SKU. "unknown" is reserved for the case
        // where the plan read itself is what failed.
        planKey: "pro_plus",
      }),
    );
  });

  it("the alert reports the price STRIPE holds, not the stale event's", async () => {
    // An out-of-order delivery names a price the item has since left. The
    // payload is a snapshot; `live` is the truth, and `currentPriceId` is the
    // field a responder acts on.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const stale = riderItem(riderId, proEntry.lookupKey, 2, "price_the_event_remembers");
    liveItems[riderId] = {
      ...(liveItems[riderId] as object),
      price: { id: "price_stripe_actually_holds", lookup_key: proEntry.lookupKey },
    };
    itemUpdateSpy.mockRejectedValue(new Error("nope"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await convergeOrgAddonPrices(subFor(stripeSubId, [planItem, stale]), walletId);
    logged.mockRestore();

    expect(repriceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ currentPriceId: "price_stripe_actually_holds" }),
    );
  });

  it("ALERTS staff when Stripe REJECTS THE CURRENCY — the #191 class, logged and not thrown", async () => {
    // The rider prices carry currency_options for eur/gbp/inr/aud. A group
    // whose subscription currency is outside that set has the item update
    // rejected outright, and the group then sits on the wrong rate for ever.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    itemUpdateSpy.mockRejectedValue(
      Object.assign(
        new Error(
          "The price specified has unit_amount_decimal in currency jpy, " +
            "but the subscription is in currency usd.",
        ),
        { code: "price_currency_mismatch", type: "StripeInvalidRequestError" },
      ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // Never throws: a rejected currency must not fail the whole webhook.
    await expect(
      processStripeEvent(
        updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
      ),
    ).resolves.toBeUndefined();

    expect(logged.mock.calls.some((c) => String(c[0]).includes(riderId))).toBe(true);
    logged.mockRestore();

    expect(repriceAlertSpy).toHaveBeenCalledTimes(1);
    expect(repriceAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: walletId,
        itemId: riderId,
        currentPriceId: livePriceFor(proEntry.lookupKey),
        expectedPriceId: livePriceFor(proPlusEntry.lookupKey),
        reason: expect.stringContaining("currency"),
      }),
    );

    // …and the rows still reconciled: only the RATE is stale.
    const [row] = await sql<{ qty: number; status: string }[]>`
      select qty, status from org_addons where stripe_item_id = ${riderId}`;
    expect(row).toMatchObject({ qty: 2, status: "active" });
  });

  it("stays silent when STAFF_ALERT_EMAIL is unset — the gate comes before the send", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    pricesListSpy.mockResolvedValue({ data: [] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await processStripeEvent(
      updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
    );
    logged.mockRestore();
    expect(repriceAlertSpy).not.toHaveBeenCalled();
  });

  it("a failing ALERT can never be what breaks the webhook", async () => {
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    pricesListSpy.mockResolvedValue({ data: [] });
    repriceAlertSpy.mockRejectedValue(new Error("resend is down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // Telemetry on a failure path must never turn "the rate is stale" into
    // "the webhook fails and Stripe retries it for ever".
    await expect(
      processStripeEvent(
        updatedEvent(stripeSubId, walletId, [riderItem(riderId, proEntry.lookupKey, 2)]),
      ),
    ).resolves.toBeUndefined();
    logged.mockRestore();

    const [row] = await sql<{ qty: number }[]>`
      select qty from org_addons where stripe_item_id = ${riderId}`;
    expect(row?.qty).toBe(2);
  });

  it("maybeAlertOrgRepriceFailed resolves rather than throwing when the send throws", async () => {
    repriceAlertSpy.mockRejectedValue(new Error("resend is down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      maybeAlertOrgRepriceFailed({
        subscriptionId: "grp",
        stripeSubscriptionId: "sub",
        planKey: "pro",
        itemId: "si",
        currentPriceId: "p1",
        expectedPriceId: "p2",
        reason: "test",
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("a CANCELED subscription is skipped — no update attempt, no alert, no noise", async () => {
    // Stripe emits a final `updated` carrying status canceled just before
    // `deleted`. Re-pricing an item on a dead subscription fails, and alerting
    // about a group that is leaving anyway is noise, not signal.
    const { walletId, stripeSubId } = await makeBilledGroupOrg("pro_plus");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = subFor(stripeSubId, [planItem, riderItem(riderId, proEntry.lookupKey, 2)]);
    (sub as { status?: string }).status = "canceled";

    await convergeOrgAddonPrices(sub, walletId);

    expect(pricesListSpy).not.toHaveBeenCalled();
    expect(itemRetrieveSpy).not.toHaveBeenCalled();
    expect(itemUpdateSpy).not.toHaveBeenCalled();
    expect(repriceAlertSpy).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

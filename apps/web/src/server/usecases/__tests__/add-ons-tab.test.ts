// v17 gap #293, SPEC-6 §A5 — the Add-ons tab's view model. Real-Postgres
// integration test: skips without DATABASE_URL. Mirrors credits-tab.test.ts.
//
// The brief's five cases are all HEALTHY fixtures, and every one of them passes
// against an implementation that derives the rendered cap from `groupOrgLimit`
// — which is the exact bug this tab has to avoid. The cases below the fold
// therefore discriminate on the states where the entitlement resolver and the
// customer's receipt disagree: dunning, an admin comp, a canceled rider, and a
// group standing above its base cap.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { walletIdFor } from "@/lib/credits";
import { groupOrgLimit } from "@/lib/billing-group";
import { seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { MAX_EXTRA_ORGS } from "../extra-orgs";
import { getAddOnsTab } from "../add-ons-tab";

const HAS_DB = !!process.env.DATABASE_URL;

/** Add `n` more live organisations to an existing group. */
async function addOrgsToGroup(
  walletId: string,
  createdBy: string | null,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const suffix = randomUUID().slice(0, 8);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${"T6 " + suffix}, ${"t6-" + suffix}, ${createdBy}, ${walletId})
      returning id`;
    ids.push(id);
  }
  return ids;
}

/** A purchased rider, as the webhook writes it: group-wide, `active`, carrying
 *  a Stripe item id. The id is UNIQUE PER CALL on purpose — V324's unique index
 *  is on `stripe_item_id` ALONE, so a literal reused across tests upserts the
 *  previous test's row onto this wallet and both tests still pass. */
async function buyRiders(walletId: string, qty: number): Promise<void> {
  await sql`
    insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                            stripe_item_id, status)
    values (${walletId}, null, 'orgs.max_owned', 1, ${qty}, ${"si_" + randomUUID()}, 'active')`;
}

describe.skipIf(!HAS_DB)("getAddOnsTab", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("a Pro payer sees the base cap, zero extra orgs, and the add-on offered", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.planKey).toBe("pro");
    expect(view.isPayer).toBe(true);
    expect(view.hasLiveSubscription).toBe(false); // smoke/tests never touch real Stripe
    expect(view.addonAvailable).toBe(true);
    expect(view.orgCap).toBe(5);
    expect(view.extraOrgCount).toBe(0);
    // The NEGATIVE half of the dunning case below. Without this, `capReduced`
    // could be hardcoded true and the whole suite would still be green — an
    // absence assertion needs a positive discriminator somewhere, and this is
    // the other end of it.
    expect(view.capReduced).toBe(false);
    expect(view.minExtraOrgs).toBe(0);
    expect(view.maxExtraOrgs).toBe(MAX_EXTRA_ORGS);
  });

  it("community cannot buy the add-on", async () => {
    const { auth } = await seedOrg("community");
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.addonAvailable).toBe(false);
    expect(view.orgCap).toBe(1);
    // Nothing to sell means nothing to quote — a price rendered next to
    // "upgrade to buy this" is an offer we do not honour.
    expect(view.priceMinor).toBeNull();
  });

  it("reflects a purchased extra-org row in both the cap and the count", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.orgCap).toBe(7);
    expect(view.extraOrgCount).toBe(2);
  });

  it("a non-payer member sees the same numbers but isPayer=false", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, "not-" + auth.userId, "usd");
    expect(view.isPayer).toBe(false);
    expect(view.orgCap).toBe(5);
  });

  it("pro_plus prices independently of pro", async () => {
    const { auth } = await seedOrg("community");
    await setOrgPlan(auth.orgId, "pro_plus");
    await invalidateOrgEntitlements(auth.orgId);
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.planKey).toBe("pro_plus");
    expect(view.orgCap).toBe(10);
  });

  // ── the cases the healthy fixtures above cannot fail on ──────────────────

  it("quotes the rider's MONTHLY SKU price, per plan and per currency", async () => {
    const pro = await seedOrg("pro");
    expect((await getAddOnsTab(pro.auth.orgId, pro.auth.userId, "usd")).priceMinor).toBe(900);
    expect((await getAddOnsTab(pro.auth.orgId, pro.auth.userId, "gbp")).priceMinor).toBe(700);

    const plus = await seedOrg("community");
    await setOrgPlan(plus.auth.orgId, "pro_plus");
    await invalidateOrgEntitlements(plus.auth.orgId);
    expect((await getAddOnsTab(plus.auth.orgId, plus.auth.userId, "usd")).priceMinor).toBe(1900);
    // The gap between the two rates is what stops "Pro + riders" undercutting
    // Pro Plus, so the tab must never quote one plan's rate on the other.
    expect((await getAddOnsTab(plus.auth.orgId, plus.auth.userId, "gbp")).priceMinor).toBe(1600);
  });

  it("shows what the group BOUGHT while dunning degrades what it may add", async () => {
    // The whole reason `orgCap` is not `groupOrgLimit`. A Pro group past its
    // 14-day dunning grace resolves to the community base, so the resolver's
    // admission cap is 1 + 2 riders = 3 while the customer is paying for 5 + 2.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 4); // 5 live orgs in total
    await sql`
      update subscriptions
         set status = 'past_due',
             status_changed_at = now() - interval '30 days',
             stripe_subscription_id = ${"sub_" + randomUUID()}
       where id = ${walletId}`;
    const orgIds = await sql<{ id: string }[]>`
      select id from organizations where subscription_id = ${walletId}`;
    for (const o of orgIds) await invalidateOrgEntitlements(o.id);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");

    // Both numbers asserted IN THE SAME TEST, deliberately: it is their
    // DISAGREEMENT that is the requirement, so anyone who later "simplifies"
    // the two calls into one reds this line.
    expect(await groupOrgLimit(walletId)).toBe(3);
    expect(view.orgCap).toBe(7);
    expect(view.capReduced).toBe(true);

    // `hasLiveSubscription` admits past_due, so the control renders — and it
    // must, because cancelling a rider is what this customer is here to do.
    expect(view.hasLiveSubscription).toBe(true);
    expect(view.extraOrgCount).toBe(2);
    // 5 live orgs against a Pro base of 5: the riders carry nobody, so both may
    // be cancelled. Off a degraded base of 1 this would be 4, clamped to 2 —
    // i.e. "you cannot cancel anything", the refusal the customer cannot act on.
    expect(view.minExtraOrgs).toBe(0);
  });

  it("counts only ACTIVE riders in the stepper, while a comp still lifts the cap", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    // An admin comp (SPEC-3): capacity the group was GIVEN. Real capacity, but
    // not a rider the customer may cancel — it has no Stripe item at all.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 3, null, 'granted')`;
    // Frozen-not-deleted (V323/V324): a cancelled rider keeps its row for ever
    // and must count for nothing, in either number.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 4, ${"si_" + randomUUID()}, 'canceled')`;

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.extraOrgCount).toBe(2); // not 5 (comp), not 6 (canceled), not 9
    expect(view.orgCap).toBe(10); // 5 base + 2 bought + 3 comped, canceled excluded
  });

  it("will not let the stepper drop below the organisations already standing on riders", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 6); // 7 live orgs on a base of 5

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.liveOrgCount).toBe(7);
    expect(view.orgCap).toBe(7);
    // Both riders are carrying an organisation, so the floor equals the count:
    // the control can raise but not lower. A hardcoded 0 fails here.
    expect(view.minExtraOrgs).toBe(2);
    expect(view.extraOrgCount).toBe(2);
  });

  it("never quotes a floor above what was purchased, even over cap", async () => {
    // Caps are ADMISSION-ONLY, so a group holding more organisations than its
    // capacity is an ordinary state (a downgrade, an expired comp). The raw
    // arithmetic would blame the whole overhang on riders and refuse a
    // cancellation with a number the customer never bought.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 1);
    await addOrgsToGroup(walletId, auth.userId, 8); // 9 live orgs, capacity 6

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.liveOrgCount).toBe(9);
    expect(view.minExtraOrgs).toBe(1); // clamped to the one rider bought, not 3
    expect(view.minExtraOrgs).toBeLessThanOrEqual(view.extraOrgCount);
  });

  it("reads a staff override as the base, not the plan row", async () => {
    // An override REPLACES the plan base, and the >= 25 population this feature
    // courts is exactly where staff write one. Reading `plan_entitlements`
    // instead would tell a comped group it is standing on riders it does not
    // need and refuse to let it cancel them.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 9); // 10 live orgs
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'orgs.max_owned', 30)`;
    await invalidateOrgEntitlements(auth.orgId);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.orgCap).toBe(32); // 30 override + 2 riders, NOT 5 + 2
    expect(view.minExtraOrgs).toBe(0); // the override carries all 10 orgs
  });
});

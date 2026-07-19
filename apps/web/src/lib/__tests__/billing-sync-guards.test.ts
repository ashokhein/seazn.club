// Subscription-sync correctness (payments-hardening Task 8, P1-5) + the Task 7
// review fold-in. Three guards, all on the webhook/reconcile sync path:
//   1. handleSubscriptionDeleted only downgrades when the deleted event names
//      the CURRENTLY stored subscription — a late-delivered delete for a
//      replaced sub must never kill a resubscribed org.
//   2. syncSubscription with a price id absent from `plans` PRESERVES the org's
//      existing plan (a stripe:sync drift is a staff problem, not a mass
//      downgrade); only a brand-new row with an unknown price lands community.
//   3. Fold-in: a re-buy (synced sub id DIFFERS from stored) clears any stale
//      disputed_at/dispute_id so an old dispute's late loss can't downgrade the
//      fresh sub; a renewal (same id) leaves the flags intact.
// Non-community plans are generic — pro AND pro_plus must behave identically.
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { syncSubscription } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const tempPlanKeys: string[] = [];

async function seedOrg(over: {
  plan?: string;
  subId?: string | null;
  status?: string;
  disputed?: boolean;
  disputeId?: string | null;
  noSub?: boolean;
} = {}): Promise<string> {
  const suffix = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`sync-${suffix}@test.local`}, 'Sync Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Sync Org " + suffix}, ${"sync-org-" + suffix}, ${ownerId}) returning id`;
  if (!over.noSub) {
    await sql`
      insert into subscriptions
        (org_id, plan_key, status, stripe_subscription_id, disputed_at, dispute_id)
      values
        (${orgId}, ${over.plan ?? "community"}, ${over.status ?? "active"},
         ${over.subId ?? null},
         ${over.disputed ? new Date().toISOString() : null},
         ${over.disputeId ?? null})`;
  }
  return orgId;
}

/** A temp plan whose monthly price is a known, unique id — proves the normal
 *  price→plan mapping still lands through the new coalesce. Torn down in afterAll. */
async function seedPlanWithPrice(): Promise<{ key: string; priceId: string }> {
  const key = `tmp_plan_${uniq()}`;
  const priceId = `price_known_${uniq()}`;
  await sql`insert into plans (key, name, stripe_price_id_monthly)
            values (${key}, ${"Temp " + key}, ${priceId})`;
  tempPlanKeys.push(key);
  return { key, priceId };
}

/** Minimal Stripe.Subscription shape syncSubscription reads. */
function stripeSub(over: {
  id: string;
  status?: Stripe.Subscription.Status;
  priceId?: string;
}): Stripe.Subscription {
  return {
    id: over.id,
    status: over.status ?? "active",
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    items: {
      data: [
        {
          price: { id: over.priceId ?? "price_unknown" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

/** A customer.subscription.deleted webhook event for one org + sub id. */
function deletedEvent(orgId: string, subId: string): Stripe.Event {
  return {
    type: "customer.subscription.deleted",
    data: { object: { id: subId, metadata: { org_id: orgId } } },
  } as unknown as Stripe.Event;
}

const readSub = async (orgId: string) =>
  (
    await sql<
      {
        plan_key: string;
        status: string;
        disputed_at: Date | null;
        dispute_id: string | null;
      }[]
    >`select plan_key, status, disputed_at, dispute_id
        from subscriptions where org_id = ${orgId}`
  )[0];

afterAll(async () => {
  if (!HAS_DB) return;
  if (tempPlanKeys.length) {
    // Subscriptions seeded onto the temp plans must go first — plans.key is
    // referenced by subscriptions_plan_key_fkey.
    await sql`delete from subscriptions where plan_key = any(${tempPlanKeys})`;
    await sql`delete from plans where key = any(${tempPlanKeys})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("handleSubscriptionDeleted — stale-event guard (P1-5)", () => {
  it("ignores a delete for a replaced sub id — the resubscribed pro org keeps its plan", async () => {
    const orgId = await seedOrg({ plan: "pro", subId: "sub_new_" + uniq() });
    await processStripeEvent(deletedEvent(orgId, "sub_old_" + uniq()));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("pro");
    expect(s.status).toBe("active");
  });

  it("ignores a stale delete for a pro_plus org just the same", async () => {
    const orgId = await seedOrg({ plan: "pro_plus", subId: "sub_new_" + uniq() });
    await processStripeEvent(deletedEvent(orgId, "sub_old_" + uniq()));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("pro_plus");
    expect(s.status).toBe("active");
  });

  it("downgrades when the delete names the CURRENT sub id", async () => {
    const subId = "sub_cur_" + uniq();
    const orgId = await seedOrg({ plan: "pro", subId });
    await processStripeEvent(deletedEvent(orgId, subId));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
  });

  it("downgrades when no sub id is stored yet (null current — nothing to protect)", async () => {
    const orgId = await seedOrg({ plan: "pro", subId: null });
    await processStripeEvent(deletedEvent(orgId, "sub_any_" + uniq()));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
  });

  it("replay of a matching delete stays community/canceled (idempotent)", async () => {
    const subId = "sub_cur_" + uniq();
    const orgId = await seedOrg({ plan: "pro", subId });
    const ev = deletedEvent(orgId, subId);
    await processStripeEvent(ev);
    await expect(processStripeEvent(ev)).resolves.toBeUndefined();
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
  });
});

describe.skipIf(!HAS_DB)("syncSubscription — unknown-price guard (P1-5)", () => {
  it("preserves a pro org's plan when the synced price is not in `plans`", async () => {
    const subId = "sub_" + uniq();
    const orgId = await seedOrg({ plan: "pro", subId });
    await syncSubscription(orgId, stripeSub({ id: subId, priceId: "price_unknown_" + uniq() }));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("pro"); // NOT silently downgraded to community
    expect(s.status).toBe("active"); // status still synced
  });

  it("preserves a pro_plus org's plan on an unknown price too", async () => {
    const subId = "sub_" + uniq();
    const orgId = await seedOrg({ plan: "pro_plus", subId });
    await syncSubscription(orgId, stripeSub({ id: subId, priceId: "price_unknown_" + uniq() }));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("pro_plus");
  });

  it("a brand-new subscription row with an unknown price still lands community", async () => {
    const orgId = await seedOrg({ noSub: true });
    await syncSubscription(orgId, stripeSub({ id: "sub_" + uniq(), priceId: "price_unknown_" + uniq() }));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe("community");
  });

  it("a KNOWN price still maps through to its plan (mapping intact)", async () => {
    const { key, priceId } = await seedPlanWithPrice();
    const subId = "sub_" + uniq();
    const orgId = await seedOrg({ plan: "community", subId });
    await syncSubscription(orgId, stripeSub({ id: subId, priceId }));
    const s = await readSub(orgId);
    expect(s.plan_key).toBe(key);
  });
});

describe.skipIf(!HAS_DB)("syncSubscription — dispute flags on re-buy vs renewal (Task 7 fold-in)", () => {
  it("a re-buy (synced sub id DIFFERS) clears stale disputed_at + dispute_id", async () => {
    const orgId = await seedOrg({
      plan: "pro",
      subId: "sub_old_" + uniq(),
      disputed: true,
      disputeId: "dp_stale_" + uniq(),
    });
    await syncSubscription(orgId, stripeSub({ id: "sub_new_" + uniq() }));
    const s = await readSub(orgId);
    expect(s.disputed_at).toBeNull();
    expect(s.dispute_id).toBeNull();
    expect(s.plan_key).toBe("pro"); // unknown price kept the plan; only flags cleared
  });

  it("a renewal (same sub id) leaves an in-flight dispute's flags intact", async () => {
    const subId = "sub_same_" + uniq();
    const did = "dp_live_" + uniq();
    const orgId = await seedOrg({ plan: "pro", subId, disputed: true, disputeId: did });
    await syncSubscription(orgId, stripeSub({ id: subId }));
    const s = await readSub(orgId);
    expect(s.disputed_at).not.toBeNull();
    expect(s.dispute_id).toBe(did);
  });
});

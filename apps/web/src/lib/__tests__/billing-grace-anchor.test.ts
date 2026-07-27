// status_changed_at maintenance (grace-anchor follow-up to payments-hardening
// Task 9): every subscription-status writer stamps status_changed_at ONLY on a
// real transition, so the 14-day past_due grace in entitlements.ts anchors on
// when dunning STARTED — repeated invoice.payment_failed retries touch
// updated_at but must never move the anchor.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { syncSubscription } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { orgPlanKey } from "@/lib/entitlements";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status";

import { setOrgPlan } from "./_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`anchor-${suffix}@test.local`}, 'Anchor Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Anchor Org " + suffix}, ${"anchor-org-" + suffix}, ${ownerId}) returning id`;
  await setOrgPlan(orgId, "community");
  return orgId;
}

/** Minimal Stripe.Subscription shape syncSubscription reads. */
function stripeSub(over: { id: string; status: Stripe.Subscription.Status }): Stripe.Subscription {
  return {
    id: over.id,
    status: over.status,
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    items: {
      data: [
        {
          price: { id: "price_unknown" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

/** Minimal invoice.payment_failed event (Stripe v22 parent.subscription_details). */
function paymentFailedEvent(subId: string): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 12)}`,
    type: "invoice.payment_failed",
    data: {
      object: {
        object: "invoice",
        parent: { subscription_details: { subscription: subId } },
      },
    },
  } as unknown as Stripe.Event;
}

async function readAnchor(orgId: string) {
  const [row] = await sql<{ status: string; status_changed_at: string | null }[]>`
    select status, status_changed_at from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return row;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("status_changed_at transition stamping", () => {
  it("syncSubscription stamps on a status change and holds on a same-status re-sync", async () => {
    const orgId = await seedOrg();
    const subId = `sub_anchor_${randomUUID().slice(0, 8)}`;

    // active(community) → past_due: transition, stamp moves to now.
    await syncSubscription(orgId, stripeSub({ id: subId, status: "past_due" }));
    const first = await readAnchor(orgId);
    expect(first.status).toBe("past_due");
    expect(first.status_changed_at).not.toBeNull();

    // Age the anchor, then re-sync the SAME status (webhook replay / retry).
    await sql`update subscriptions
              set status_changed_at = now() - interval '5 days'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await syncSubscription(orgId, stripeSub({ id: subId, status: "past_due" }));
    const held = await readAnchor(orgId);
    expect(new Date(held.status_changed_at!).getTime()).toBeLessThan(Date.now() - 4 * 86_400_000); // still ~5 days old — not re-stamped

    // past_due → active: transition again, stamp moves forward.
    await syncSubscription(orgId, stripeSub({ id: subId, status: "active" }));
    const flipped = await readAnchor(orgId);
    expect(new Date(flipped.status_changed_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("repeated invoice.payment_failed events do not move the anchor", async () => {
    const orgId = await seedOrg();
    const subId = `sub_dun_${randomUUID().slice(0, 8)}`;
    await sql`update subscriptions
              set plan_key = 'pro', status = 'active', stripe_subscription_id = ${subId}
              where id = (select subscription_id from organizations where id = ${orgId})`;

    // First failure: active → past_due, anchor stamped.
    await processStripeEvent(paymentFailedEvent(subId));
    const first = await readAnchor(orgId);
    expect(first.status).toBe("past_due");
    expect(first.status_changed_at).not.toBeNull();
    expect(new Date(first.status_changed_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Age the anchor, then a dunning RETRY fails again — same status, anchor holds.
    await sql`update subscriptions
              set status_changed_at = now() - interval '10 days'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await processStripeEvent(paymentFailedEvent(subId));
    const held = await readAnchor(orgId);
    expect(held.status).toBe("past_due");
    expect(new Date(held.status_changed_at!).getTime()).toBeLessThan(Date.now() - 9 * 86_400_000);
  });
});

// The bug this closes (#206 / #223-B): a checkout whose FIRST payment never
// confirmed (abandoned 3DS, declined card at the sheet) lands `incomplete`.
// STATUS_MAP used to fold that into past_due, and the 14-day past_due grace
// then handed the org full Pro, paid for nothing, until Stripe expired the
// subscription ~23h later. `incomplete` is now a distinct status the resolver
// grants nothing — while genuine dunning (a renewal that failed after the sub
// was active) still gets its grace.
describe.skipIf(!HAS_DB)("incomplete never-paid grace hole (#206)", () => {
  async function setSub(
    orgId: string,
    over: { status: string; plan_key?: string; ageDays?: number },
  ) {
    await sql`
      update subscriptions
         set plan_key = ${over.plan_key ?? "pro"},
             status = ${over.status},
             stripe_subscription_id = ${`sub_${randomUUID().slice(0, 8)}`},
             status_changed_at = now() - (${over.ageDays ?? 0} * interval '1 day')
       where id = (select subscription_id from organizations where id = ${orgId})`;
  }

  it("an incomplete subscription conveys NO plan, even fresh inside the 14-day window", async () => {
    const orgId = await seedOrg();
    await setSub(orgId, { status: "incomplete", plan_key: "pro", ageDays: 0 });
    // Before the fix this returned 'pro' (incomplete → past_due → grace).
    expect(await orgPlanKey(orgId)).toBe("community");
  });

  it("a genuine past_due keeps Pro through the grace, then degrades — unchanged", async () => {
    const orgId = await seedOrg();
    await setSub(orgId, { status: "past_due", plan_key: "pro", ageDays: 3 });
    expect(await orgPlanKey(orgId)).toBe("pro"); // within 14-day grace
    await setSub(orgId, { status: "past_due", plan_key: "pro", ageDays: 15 });
    expect(await orgPlanKey(orgId)).toBe("community"); // past the grace
  });

  it("syncSubscription writes Stripe `incomplete` as our incomplete, not past_due", async () => {
    const orgId = await seedOrg();
    const subId = `sub_inc_${randomUUID().slice(0, 8)}`;
    await syncSubscription(orgId, stripeSub({ id: subId, status: "incomplete" }));
    // Same caveat as the 'unpaid' row below, and this is the row it bites on:
    // 'incomplete' is ALSO the `??` fallback, so deleting STATUS_MAP.incomplete
    // leaves this green. Mutate by flipping the value.
    expect((await readAnchor(orgId)).status).toBe("incomplete");
  });

  it("syncSubscription writes Stripe 'unpaid' as our past_due — never a literal 'unpaid' row (#288 audit)", async () => {
    const orgId = await seedOrg();
    const subId = `sub_unpaid_${randomUUID().slice(0, 8)}`;
    await syncSubscription(orgId, stripeSub({ id: subId, status: "unpaid" }));
    // STATUS_MAP (lib/billing.ts) collapses 'unpaid' into 'past_due' at
    // write time — the resolver's existing past_due 14-day grace arm
    // degrades it, exactly like any other dunning failure. Neither
    // resolver needs its own 'unpaid' arm because the literal string
    // never reaches subscriptions.status.
    //
    // CAVEAT: this pins the observable WRITE, not the map entry. Mutate it by
    // flipping the VALUE of STATUS_MAP.unpaid, never by reasoning about the
    // key alone — behind a `?? fallback`, deleting a key is not the same
    // mutation as changing it, and which of the two this test catches depends
    // entirely on what the fallback currently is. It happens to catch both
    // today (Task 8 (e) moved the fallback to 'incomplete', so a deleted
    // 'unpaid' key now lands somewhere this assertion rejects) — but that is a
    // property of the fallback, not of this test, and it flips back the moment
    // the fallback changes. The deletion-blind row is now the `incomplete` one
    // below, whose expected value IS the fallback.
    expect((await readAnchor(orgId)).status).toBe("past_due");
  });

  // v17 W2 Task 8 (e). STATUS_MAP is a fixed table against a vocabulary Stripe
  // can extend at any time, so the `??` fallback is the arm that handles every
  // status this codebase has never heard of. It used to be `past_due`, which
  // fails OPEN: an unknown NEVER-PAID status (the likely shape of anything new
  // in the incomplete family) would inherit the 14-day dunning grace and hand
  // out Pro, paid for nothing, until someone noticed. `incomplete` is the
  // fail-SAFE landing — it conveys no plan, and it is still a LIVE status, so
  // the subscription is not orphaned and a second checkout stays blocked.
  it("an UNKNOWN future Stripe status lands as incomplete — no plan, no grace", async () => {
    const orgId = await seedOrg();
    await sql`update subscriptions set plan_key = 'pro'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    const subId = `sub_future_${randomUUID().slice(0, 8)}`;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncSubscription(
      orgId,
      stripeSub({
        id: subId,
        // A status no STATUS_MAP key matches — deliberately not a real one.
        status: "some_future_status" as Stripe.Subscription.Status,
      }),
    );
    // Pre-fix this wrote 'past_due', and the assertion below returned 'pro'
    // for 14 days on a subscription that had paid nothing.
    expect((await readAnchor(orgId)).status).toBe("incomplete");
    expect(await orgPlanKey(orgId)).toBe("community");
    // Still LIVE, though — the org owns a real Stripe subscription, so it must
    // not be able to open a second checkout and mint a duplicate.
    expect(LIVE_SUBSCRIPTION_STATUSES).toContain("incomplete");
    // And it is LOUD. Degrading a possibly-paying customer silently is how a
    // STATUS_MAP drift survives in production — the subscription id is in the
    // log because a status alone gives nobody anything to look up.
    expect(err).toHaveBeenCalledWith(
      "syncSubscription: unknown status",
      "some_future_status",
      subId,
    );
    err.mockRestore();
  });

  it("syncSubscription writes Stripe 'incomplete_expired' as our canceled — degrades immediately, no grace (#288 audit)", async () => {
    const orgId = await seedOrg();
    const subId = `sub_ie_${randomUUID().slice(0, 8)}`;
    await sql`update subscriptions set plan_key = 'pro'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await syncSubscription(orgId, stripeSub({ id: subId, status: "incomplete_expired" }));
    const row = await readAnchor(orgId);
    expect(row.status).toBe("canceled");
    // canceled + comped_at null is the immediate-degrade arm (no 14-day
    // grace) in BOTH resolvers — unlike past_due above. Proves the
    // DEGRADE from a paid-looking row, not just that plan_key already
    // happened to read community.
    expect(await orgPlanKey(orgId)).toBe("community");
  });
});

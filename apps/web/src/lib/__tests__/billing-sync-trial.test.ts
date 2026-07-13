// trial_used_at lifecycle (product gap 2026-07-13): syncSubscription stamps
// it the first time a Stripe sub carries a trial, and the stamp SURVIVES the
// downgrade→upgrade loop — a second checkout must resolve trialDays 0.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { checkoutTrialDays, syncSubscription } from "@/lib/billing";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`trial-${suffix}@test.local`}, 'Trial Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Trial Org " + suffix}, ${"trial-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')`;
  return orgId;
}

/** Minimal Stripe.Subscription shape syncSubscription reads. */
function stripeSub(over: {
  id: string;
  status: Stripe.Subscription.Status;
  trial_end?: number | null;
}): Stripe.Subscription {
  return {
    id: over.id,
    status: over.status,
    trial_end: over.trial_end ?? null,
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

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("trial_used_at stamping (one trial per org)", () => {
  it("stamps on the first trialing sync; never re-arms through the loop", async () => {
    const orgId = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];

    // Fresh org: no stamp → a checkout would carry the 14-day trial.
    expect((await readSub()).trial_used_at).toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(14);

    // Trial starts (reconcile/webhook path).
    await syncSubscription(
      orgId,
      stripeSub({ id: "sub_trial1", status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 14 * 86_400 }),
    );
    const stamped = (await readSub()).trial_used_at;
    expect(stamped).not.toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(0);

    // Trial lapses → Stripe cancels → org back on community. Stamp survives.
    await syncSubscription(
      orgId,
      stripeSub({ id: "sub_trial1", status: "canceled", trial_end: null }),
    );
    expect((await readSub()).trial_used_at).toEqual(stamped);
    expect(checkoutTrialDays(await readSub())).toBe(0);

    // Second (no-trial) subscription syncs — stamp still the original.
    await syncSubscription(orgId, stripeSub({ id: "sub_paid2", status: "active" }));
    expect((await readSub()).trial_used_at).toEqual(stamped);
  });

  it("a paid-from-day-one sub does not stamp a trial", async () => {
    const orgId = await seedOrg();
    await syncSubscription(orgId, stripeSub({ id: "sub_paid", status: "active" }));
    const [row] = await sql<{ trial_used_at: string | null }[]>`
      select trial_used_at from subscriptions where org_id = ${orgId}`;
    expect(row.trial_used_at).toBeNull();
  });
});

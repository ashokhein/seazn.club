// trial_used_at lifecycle (product gap 2026-07-13): syncSubscription stamps
// it on the FIRST sync of any Stripe sub — trialing or not, since the column
// means "this org has had Pro" — and the stamp SURVIVES the downgrade→upgrade
// loop, so a second checkout must resolve trialDays 0.
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

  // A paid-from-day-one sub carries no trial_end — but it IS an org that has
  // had Pro, so the stamp lands even though trial_end stays null.
  it("a paid-from-day-one sub stamps the org without recording a trial_end", async () => {
    const orgId = await seedOrg();
    await syncSubscription(orgId, stripeSub({ id: "sub_paid", status: "active" }));
    const [row] = await sql<{ trial_end: string | null; trial_used_at: string | null }[]>`
      select trial_end, trial_used_at from subscriptions where org_id = ${orgId}`;
    expect(row.trial_end).toBeNull();
    expect(row.trial_used_at).not.toBeNull();
  });

  // A subscription created in the Stripe dashboard (invoice-billed, no trial)
  // is still an org that has HAD Pro — V277's own backfill counted it, the
  // ongoing code did not.
  it("stamps a subscription that never carried a trial", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_notrial", status: "active" }));
    const stamped = await readStamp();
    expect(stamped).not.toBeNull();
    expect(checkoutTrialDays({ trial_used_at: stamped })).toBe(0);
  });

  it("a replay of the same event does not re-date the stamp", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_replay", status: "active" }));
    const first = await readStamp();
    // Guard: without this, a regression that stops stamping entirely leaves
    // both sides null and the toEqual below passes vacuously.
    expect(first).not.toBeNull();
    await syncSubscription(orgId, stripeSub({ id: "sub_replay", status: "active" }));
    expect(await readStamp()).toEqual(first);
  });

  // Task 7 of the payments wave clears dispute flags on a re-buy. That reset
  // must not take trial_used_at with it — they share one upsert.
  it("a re-buy under a NEW subscription id keeps the original stamp", async () => {
    const orgId = await seedOrg();
    const readStamp = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0].trial_used_at;

    await syncSubscription(orgId, stripeSub({ id: "sub_first", status: "active" }));
    const first = await readStamp();
    // Guard: without this, a regression that stops stamping entirely leaves
    // both sides null and the toEqual below passes vacuously.
    expect(first).not.toBeNull();
    await sql`update subscriptions set status = 'canceled' where org_id = ${orgId}`;
    await syncSubscription(orgId, stripeSub({ id: "sub_second", status: "active" }));
    expect(await readStamp()).toEqual(first);
  });
});

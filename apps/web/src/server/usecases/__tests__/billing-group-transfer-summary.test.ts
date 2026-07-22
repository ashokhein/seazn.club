// The recipient-visible COST SUMMARY carried on an incoming transfer offer
// (spec 2026-07-22 transfer-offer-recipient-surface §C).
//
// A recipient used to add a card blind — no plan, no amount, no renewal. The
// financial truth accepting a transfer states is "No charge today": handOverGroup
// only makes the incoming card the default, the current period is already paid.
// So the summary's charge_now_minor is ALWAYS 0; the LOCAL fields (plan_key,
// org_count, currency, renewal_date) are asserted here. The Stripe renewal is
// best-effort and null for a group with no live subscription, which is what this
// seeds — the exact number is only ever verified against a real test account.
//
// Own fixture port so the setupIntents.retrieve for the recipient's client_secret
// answers over HTTP instead of reaching the internet.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12118";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { listGroupTransferOffers } from "@/server/usecases/billing-groups";
import {
  startStripeFixtureServer,
  type StripeFixtureServer,
} from "../../../../e2e/stripe-fixture-server";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
let fixture: StripeFixtureServer;

async function makeUser(label: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${label}-${uniq()}@test.local`}, ${label}, true) returning id`;
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12118);
});
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("listGroupTransferOffers — recipient cost summary", () => {
  it("attaches a summary to the recipient's incoming offer, and none to the offerer's outgoing view", async () => {
    const payer = await makeUser("summary-payer");
    const heir = await makeUser("summary-heir");
    const setupIntentId = "seti_" + uniq();

    // A group the payer owns with NO live Stripe subscription (community-shaped:
    // status active, plan pro, no stripe_subscription_id) — the renewal is
    // best-effort and must come back null without any Stripe subscription call.
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, currency,
         current_period_end, status_changed_at)
      values (${payer}, 'pro', 'active', 2, 'gbp',
              now() + interval '20 days', now())
      returning id`;

    // Two live orgs on the group (org_count = 2), plus a deleted one that the
    // count must EXCLUDE.
    for (const n of [1, 2]) {
      const s = uniq();
      await sql`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Sum Org ${n} ${s}`}, ${`sum-${n}-${s}`}, ${payer}, ${groupId})`;
    }
    const heirSlug = uniq();
    await sql`
      insert into organizations (name, slug, created_by, subscription_id, deleted_at)
      values (${`Sum Gone ${heirSlug}`}, ${`sum-gone-${heirSlug}`}, ${payer}, ${groupId}, now())`;
    // The offer TO the heir.
    await sql`
      insert into billing_group_transfers
        (subscription_id, from_user_id, to_user_id, setup_intent_id, status, expires_at)
      values (${groupId}, ${payer}, ${heir}, ${setupIntentId}, 'pending',
              now() + interval '1 hour')`;

    // Recipient view: the offer carries a summary.
    const heirOffers = await listGroupTransferOffers(heir);
    const mine = heirOffers.find((o) => o.setup_intent_id === setupIntentId);
    expect(mine?.direction).toBe("made_to_me");
    expect(mine?.summary).toBeTruthy();
    expect(mine?.summary?.charge_now_minor).toBe(0);
    expect(mine?.summary?.plan_key).toBe("pro");
    expect(mine?.summary?.org_count).toBe(2); // the deleted org is excluded
    expect(mine?.summary?.currency).toBe("gbp");
    expect(typeof mine?.summary?.renewal_date).toBe("number");
    // The discriminator the recipient copy keys off: this group carries a
    // current_period_end (so renewal_date is a number) but has NO live Stripe
    // subscription, so has_live_subscription must be false — the case that would
    // otherwise render a false "billed at renewal" line off the stale date.
    expect(mine?.summary?.has_live_subscription).toBe(false);
    // No live subscription → best-effort renewal is null (never the exact number).
    expect(mine?.summary?.renewal).toBeNull();

    // Offerer view: same offer, outgoing, NO summary.
    const payerOffers = await listGroupTransferOffers(payer);
    const outgoing = payerOffers.find((o) => o.setup_intent_id === setupIntentId);
    expect(outgoing?.direction).toBe("made_by_me");
    expect(outgoing?.summary ?? null).toBeNull();
  });
});

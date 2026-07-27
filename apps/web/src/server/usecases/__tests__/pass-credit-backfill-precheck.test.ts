// The backfill's "already capped, skip this group" pre-check
// (scripts/backfill-pass-credit-redemptions.ts) is a hand-written mirror of the
// `pass_credit_redemptions_group_cap` partial unique index. V337 (#286) widened
// that index to `reversed_at is null or reversal_undetermined_at is not null`
// so an UNDETERMINED reversal keeps holding the group's one lifetime credit;
// the script's copy was left on the narrow pre-V337 predicate.
//
// That divergence is not cosmetic. A group whose only redemption is
// undetermined reads FREE to the script, so it reconstructs a redemption for a
// group that already has one (the earlier credit was never actually clawed
// back — that is what "undetermined" means). And because the insert is
// `on conflict (payment_intent) do nothing` — which only absorbs the SAME
// intent — a DIFFERENT intent for the same subscription raises 23505 against
// the widened index, inside a loop body with no try/catch: one such group
// aborts the entire backfill run.
//
// Pinned against real Postgres rather than by re-reading the SQL string,
// because the assertion that matters is "this predicate and that index agree",
// and only the database can answer that. Skipped without DATABASE_URL, same as
// the sibling pass-credit suites.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { groupAlreadyCapped } from "../../../../../../scripts/backfill-pass-credit-redemptions";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);
const orgIds: string[] = [];

async function seedOrgAndSubscription(): Promise<{ orgId: string; subscriptionId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Backfill Org " + suffix}, ${"backfill-org-" + suffix}) returning id`;
  orgIds.push(orgId);
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('backfillowner-' || gen_random_uuid() || '@test.local', 'Backfill Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id, currency)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active',
             ${"cus_" + suffix}, 'gbp'
      from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ subscription_id: subscriptionId }] = await sql<{ subscription_id: string }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  return { orgId, subscriptionId };
}

async function seedRedemption(opts: {
  subscriptionId: string;
  orgId: string;
  reversed?: boolean;
  undetermined?: boolean;
}): Promise<void> {
  const suffix = uniq();
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${opts.orgId}, ${"Backfill Cup " + suffix}, ${"backfill-cup-" + suffix}) returning id`;
  const now = new Date().toISOString();
  await sql`
    insert into pass_credit_redemptions
      (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency,
       reversed_at, reversed_minor, reversal_undetermined_at)
    values (
      ${opts.subscriptionId}, ${opts.orgId}, ${competitionId}, ${"pi_" + suffix}, 2500, 'gbp',
      ${opts.reversed ? now : null}, ${opts.reversed ? 0 : null},
      ${opts.undetermined ? now : null}
    )`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`delete from competitions where org_id = any(${orgIds})`;
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
      where id = any(${orgIds}) and subscription_id is not null`;
    await sql`delete from organizations where id = any(${orgIds})`;
    if (groups.length)
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("backfill pre-check: groupAlreadyCapped", () => {
  it("reads a group with NO redemption row as free to backfill", async () => {
    const { subscriptionId } = await seedOrgAndSubscription();
    expect(await groupAlreadyCapped(sql, subscriptionId)).toBe(false);
  });

  it("reads a group holding a LIVE redemption as already capped", async () => {
    const { orgId, subscriptionId } = await seedOrgAndSubscription();
    await seedRedemption({ subscriptionId, orgId });
    expect(await groupAlreadyCapped(sql, subscriptionId)).toBe(true);
  });

  it("reads a group whose only redemption was UNDETERMINED as already capped", async () => {
    // Money bug: reversed_at is stamped (the webhook-idempotency marker) but
    // reversal_undetermined_at says nothing was actually clawed back, so the
    // customer still holds that credit. Pre-fix the narrow `reversed_at is
    // null` pre-check read this group as FREE.
    const { orgId, subscriptionId } = await seedOrgAndSubscription();
    await seedRedemption({ subscriptionId, orgId, reversed: true, undetermined: true });
    expect(await groupAlreadyCapped(sql, subscriptionId)).toBe(true);
  });

  it("agrees with the cap index: a group it reads as capped REJECTS a fresh insert", async () => {
    // The real reason the two must agree. `on conflict (payment_intent) do
    // nothing` only absorbs the same intent; a DIFFERENT intent for this
    // subscription hits pass_credit_redemptions_group_cap, and the backfill's
    // loop body has no try/catch — a disagreement here aborts the whole run.
    const { orgId, subscriptionId } = await seedOrgAndSubscription();
    await seedRedemption({ subscriptionId, orgId, reversed: true, undetermined: true });
    expect(await groupAlreadyCapped(sql, subscriptionId)).toBe(true);

    const [{ id: competitionId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${orgId}, ${"Second Cup " + uniq()}, ${"second-cup-" + uniq()}) returning id`;
    await expect(
      sql`
        insert into pass_credit_redemptions
          (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency)
        values (${subscriptionId}, ${orgId}, ${competitionId}, ${"pi_" + uniq()}, 2500, 'gbp')
        on conflict (payment_intent) do nothing`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("reads a group whose redemption was cleanly reversed as free to backfill", async () => {
    // A DETERMINED reversal did claw the money back, so the index releases the
    // group — the pre-check must not over-hold either.
    const { orgId, subscriptionId } = await seedOrgAndSubscription();
    await seedRedemption({ subscriptionId, orgId, reversed: true });
    expect(await groupAlreadyCapped(sql, subscriptionId)).toBe(false);
  });
});

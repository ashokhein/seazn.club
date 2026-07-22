// Admin plan tools (v3/08 §1, PROMPT-37): comp-to-Pro honours its end date at
// resolution time, override expiry lapses, downgrade preview names exactly the
// competitions the freeze would catch, and every action lands in the audit
// with its reason. Real Postgres; Stripe never touched (comped orgs only).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Finding 1 (Task 6C review): planPanel is the shared "before" snapshot read
// by compToPro, adminDowngrade and extendTrial — none of them ever read
// .cards. This mock lets the test below prove planPanel makes NO Stripe call,
// even for an org that HAS a stripe_customer_id (the one case that used to
// reach Stripe at all). No test in this file ever drives extendTrial's live
// Stripe-update arm to completion (every "live" scenario here is refused by
// the 400 guard before any Stripe call), so a bare mock with no
// `subscriptions` key is safe for the rest of the suite.
const stripeMock = vi.hoisted(() => ({
  retrieveCustomer: vi.fn(),
  listPaymentMethods: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listPaymentMethods: stripeMock.listPaymentMethods,
    },
  }),
}));

import { sql } from "@/lib/db";
import { checkoutTrialDays } from "@/lib/billing";
import { hasFeature } from "@/lib/entitlements";
import {
  adminDowngrade,
  compToPro,
  downgradeFreezePreview,
  extendTrial,
  planPanel,
  restoreTrial,
} from "@/server/usecases/admin-plan";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
});

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Adm " + s}, ${"adm-" + s}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active') on conflict (org_id) do nothing`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staff-" + s + "@test.local"}, 'Staff', true, 'superadmin') returning id`;
  return { orgId, actorId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("admin plan tools", () => {
  it("comp-to-Pro grants Pro; a past end date resolves back to community", async () => {
    const { orgId, actorId } = await seedOrg();
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    await compToPro(actorId, orgId, null, "founder friend");
    expect(await hasFeature(orgId, "api.access")).toBe(true);
    expect((await planPanel(orgId)).source).toBe("comped");

    // Clock-controlled lapse: write a past comped_until directly, then check
    // resolution treats the org as community without any job running.
    await sql`update subscriptions set comped_until = now() - interval '1 day' where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    const [audit] = await sql<{ detail: { reason: string } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'comp_to_pro' order by created_at desc limit 1`;
    expect(audit.detail.reason).toBe("founder friend");
  });

  it("an entitlement override with a lapsed expiry stops resolving", async () => {
    const { orgId } = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at, reason)
      values (${orgId}, 'api.access', true, now() + interval '1 hour', 'test')`;
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    await sql`
      update org_entitlement_overrides set expires_at = now() - interval '1 minute'
      where org_id = ${orgId} and feature_key = 'api.access'`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("downgrade preview lists the over-quota competitions, then the downgrade freezes them", async () => {
    const { orgId, actorId } = await seedOrg();
    await compToPro(actorId, orgId, null, "pre-test comp");
    const s = randomUUID().slice(0, 8);
    // Seven active competitions against a community cap of 5 (V311 raised it
    // from 1) — two over, so the "two stalest freeze" arithmetic below still
    // exercises a partial freeze rather than an all-or-nothing one.
    for (const n of ["One", "Two", "Three", "Four", "Five", "Six", "Seven"]) {
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${orgId}, ${n + " " + s}, ${n.toLowerCase() + "-" + s}, 'published')`;
    }

    const preview = await downgradeFreezePreview(orgId);
    expect(preview.limit).toBe(5); // community quota (V311)
    expect(preview.active).toBe(7);
    expect(preview.frozen).toHaveLength(2); // the two stalest

    const result = await adminDowngrade(actorId, orgId, "abuse of comp");
    expect(result.frozen).toHaveLength(2);
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("community");

    const [audit] = await sql<{ detail: { reason: string; after: { frozen: string[] } } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'admin_downgrade' limit 1`;
    expect(audit.detail.reason).toBe("abuse of comp");
    expect(audit.detail.after.frozen).toHaveLength(2);
  });

  it("extendTrial moves trial_end forward from now (no Stripe sub) and audits", async () => {
    const { orgId, actorId } = await seedOrg();
    const end = await extendTrial(actorId, orgId, 14, "sales call");
    const days = (new Date(end).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const [row] = await sql<{ status: string }[]>`
      select status from subscriptions where org_id = ${orgId}`;
    expect(row.status).toBe("trialing");
  });

  // One trial per org (V277) counts EVERY trial, not just Stripe's. An
  // admin-granted trial used to leave trial_used_at null, so the org could
  // downgrade and take a fresh 14-day checkout trial afterwards.
  it("a granted trial burns the org's one trial", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];
    expect(checkoutTrialDays(await readSub())).toBe(14);

    await extendTrial(actorId, orgId, 14, "sales call");
    expect((await readSub()).trial_used_at).not.toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(0);

    // Backdate the stamp so a re-dating write cannot land on the same
    // millisecond as the original — otherwise the equality below would hold
    // even without the coalesce.
    await sql`update subscriptions set trial_used_at = now() - interval '30 days'
              where org_id = ${orgId}`;
    const stamped = (await readSub()).trial_used_at;
    expect(stamped).not.toBeNull();

    // A second grant extends the trial but never re-dates the stamp.
    await extendTrial(actorId, orgId, 7, "one more week");
    expect((await readSub()).trial_used_at).toEqual(stamped);
  });

  // A comp is free Pro — the org has had its free ride, so a later self-serve
  // upgrade bills from day one. This is the user-reported symptom: an org that
  // was comped, then downgraded, was still offered the 14-day trial.
  it("comp-to-Pro burns the trial, and a downgrade does not give it back", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];
    expect(checkoutTrialDays(await readSub())).toBe(14);

    await compToPro(actorId, orgId, null, "founder friend");
    expect((await readSub()).trial_used_at).not.toBeNull();

    // Backdate the stamp so a re-dating write cannot land on the same
    // millisecond as the original — otherwise the equality below would hold
    // even without the coalesce.
    await sql`update subscriptions set trial_used_at = now() - interval '30 days'
              where org_id = ${orgId}`;
    const stamped = (await readSub()).trial_used_at;
    expect(stamped).not.toBeNull();

    await compToPro(actorId, orgId, null, "extended the comp");
    expect((await readSub()).trial_used_at).toEqual(stamped);

    await adminDowngrade(actorId, orgId, "comp ended");
    expect(checkoutTrialDays(await readSub())).toBe(0);
  });

  it("a grant to a Community org conveys real Pro, then lapses on its own", async () => {
    const { orgId, actorId } = await seedOrg();
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    await extendTrial(actorId, orgId, 7, "sales call");
    const [row] = await sql<
      { plan_key: string; comped_until: string | null; trial_end: string | null }[]
    >`select plan_key, comped_until, trial_end from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro");
    // Both null would satisfy the equality below if the writes were dropped.
    expect(row.comped_until).not.toBeNull();
    expect(row.comped_until).toEqual(row.trial_end);
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    // Clock-controlled lapse — no job flips it, the resolver does.
    await sql`update subscriptions set comped_until = now() - interval '1 minute',
                                       trial_end    = now() - interval '1 minute'
              where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("stacked grants extend from the existing end and keep the first stamp", async () => {
    const { orgId, actorId } = await seedOrg();
    const first = await extendTrial(actorId, orgId, 7, "one");
    // Backdate before re-reading the baseline: two now() writes in the same
    // millisecond compare equal, so without this the stamp assertion below
    // would hold even with the coalesce removed.
    await sql`update subscriptions set trial_used_at = now() - interval '30 days'
              where org_id = ${orgId}`;
    const [{ trial_used_at: stamped }] = await sql<{ trial_used_at: string }[]>`
      select trial_used_at from subscriptions where org_id = ${orgId}`;
    expect(stamped).not.toBeNull();

    const second = await extendTrial(actorId, orgId, 7, "two");
    const days = (new Date(second).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());

    const [after] = await sql<{ trial_used_at: string; comped_until: string }[]>`
      select trial_used_at, comped_until from subscriptions where org_id = ${orgId}`;
    expect(after.trial_used_at).toEqual(stamped);
    expect(new Date(after.comped_until).toISOString()).toBe(second);
  });

  it("does not demote an org already comped above Pro", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions set plan_key = 'pro_plus' where org_id = ${orgId}`;
    await extendTrial(actorId, orgId, 7, "keep the plus");
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro_plus");
  });

  // A cancelled subscription keeps its id. Without the liveness test this org
  // would take the Stripe arm and we would call subscriptions.update on a dead
  // subscription; without the resolver widening, its grant would never expire.
  it("treats a cancelled subscription as no subscription, and the grant still lapses", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dead', status = 'canceled'
               where org_id = ${orgId}`;

    await extendTrial(actorId, orgId, 7, "win-back");
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    await sql`update subscriptions set comped_until = now() - interval '1 minute'
              where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  // A cancelled subscription is not a billing relationship: staff must still be
  // able to comp a departed org back to Pro.
  it("comps an org whose subscription was cancelled", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled'
               where org_id = ${orgId}`;
    await compToPro(actorId, orgId, null, "win-back comp");
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro");
    expect(await hasFeature(orgId, "api.access")).toBe(true);
  });

  // The comp must also LAPSE. Writing a live-looking status onto the departed
  // row would resurrect liveness and the resolver's comp-expiry arm could never
  // fire — the org would sit on free Pro for ever (and be locked out of
  // checkout). A null end date hides this, so this one is dated.
  it("a dated comp on a departed org still lapses", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled'
               where org_id = ${orgId}`;

    await compToPro(actorId, orgId, new Date(Date.now() + 30 * 86_400_000), "win-back comp");
    expect(await hasFeature(orgId, "api.access")).toBe(true);
    const [row] = await sql<{ status: string; comped_until: string | null }[]>`
      select status, comped_until from subscriptions where org_id = ${orgId}`;
    expect(row.comped_until).not.toBeNull();
    // The dead id keeps its cancelled status: nothing may fake liveness.
    expect(row.status).toBe("canceled");

    await sql`update subscriptions set comped_until = now() - interval '1 minute'
              where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  // Comp is reversible-IN (above) — it must be reversible-OUT too. The downgrade
  // guard used to test the id's PRESENCE, so once staff comped a departed org
  // (dead id, cancelled status) the un-comp threw 400 "billed through Stripe"
  // and there was no way back — with `until: null` that meant free Pro for ever.
  it("un-comps a departed org: adminDowngrade reverses a comp on a cancelled subscription", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled'
               where org_id = ${orgId}`;
    await compToPro(actorId, orgId, null, "win-back comp");
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    await adminDowngrade(actorId, orgId, "comp withdrawn");

    const [row] = await sql<{ plan_key: string; comped_until: string | null }[]>`
      select plan_key, comped_until from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("community");
    expect(row.comped_until).toBeNull();
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("does not label a cancelled subscription as a Stripe-sourced plan", async () => {
    const { orgId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled'
               where org_id = ${orgId}`;
    expect((await planPanel(orgId)).source).not.toBe("stripe");

    await sql`update subscriptions set status = 'active' where org_id = ${orgId}`;
    expect((await planPanel(orgId)).source).toBe("stripe");
  });

  it("refuses a live paying subscription and writes nothing", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_live', status = 'active',
                     plan_key = 'pro'
               where org_id = ${orgId}`;
    const readRow = async () =>
      (
        await sql<Record<string, unknown>[]>`
          select plan_key, status, trial_end, comped_until, trial_used_at,
                 status_changed_at, updated_at
          from subscriptions where org_id = ${orgId}`
      )[0];
    const before = await readRow();
    expect(before.plan_key).toBe("pro");

    await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    expect(await readRow()).toEqual(before);
  });

  it("refuses a subscription in dunning for the same reason", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dunning', status = 'past_due'
               where org_id = ${orgId}`;
    const readRow = async () =>
      (
        await sql<Record<string, unknown>[]>`
          select plan_key, status, trial_end, comped_until, trial_used_at,
                 status_changed_at, updated_at
          from subscriptions where org_id = ${orgId}`
      )[0];
    const before = await readRow();
    expect(before.status).toBe("past_due");

    await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    expect(await readRow()).toEqual(before);
  });

  it("still enforces the day bounds", async () => {
    const { orgId, actorId } = await seedOrg();
    await expect(extendTrial(actorId, orgId, 0, "nope")).rejects.toThrow(/1–365/);
    await expect(extendTrial(actorId, orgId, 366, "nope")).rejects.toThrow(/1–365/);
  });

  it("restore trial clears the stamp, audits it, and is not a permanent bypass", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];

    await compToPro(actorId, orgId, null, "comp that became a deal");
    expect(checkoutTrialDays(await readSub())).toBe(0);

    await restoreTrial(actorId, orgId, "comp converted to a paid pilot");
    expect((await readSub()).trial_used_at).toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(14);

    const [audit] = await sql<{ detail: { reason: string } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'restore_trial' order by created_at desc limit 1`;
    expect(audit.detail.reason).toBe("comp converted to a paid pilot");

    // The hatch reopens the door once — the next grant closes it again.
    await extendTrial(actorId, orgId, 7, "pilot extension");
    expect(checkoutTrialDays(await readSub())).toBe(0);
  });

  it("restore trial demands a reason", async () => {
    const { orgId, actorId } = await seedOrg();
    await expect(restoreTrial(actorId, orgId, "  ")).rejects.toThrow(/reason/i);
  });

  // The crux of the escape hatch: syncSubscription re-stamps trial_used_at on
  // every sync of ANY live subscription (coalesce keeps the first date), so
  // clearing the burn on a Stripe-billed org would be silently undone by the
  // next webhook. An honest 400 beats a restore that reverts itself.
  it("refuses to restore a trial while a live Stripe subscription exists, and writes nothing", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_live', status = 'active',
                     plan_key = 'pro', trial_used_at = now() - interval '30 days'
               where org_id = ${orgId}`;
    const before = (
      await sql<{ trial_used_at: string }[]>`
        select trial_used_at from subscriptions where org_id = ${orgId}`
    )[0];

    await expect(restoreTrial(actorId, orgId, "please undo")).rejects.toThrow(/Stripe/i);

    const after = (
      await sql<{ trial_used_at: string }[]>`
        select trial_used_at from subscriptions where org_id = ${orgId}`
    )[0];
    expect(after.trial_used_at).toEqual(before.trial_used_at);
    const audits = await sql<{ id: string }[]>`
      select id from staff_audit_log where target_id = ${orgId} and action = 'restore_trial'`;
    expect(audits).toHaveLength(0);
  });

  // A cancelled subscription keeps its id forever — presence alone is not
  // liveness. A departed org is exactly the case this hatch exists for, so it
  // must be allowed through even though `stripe_subscription_id` is non-null.
  it("restores a trial for a departed org (cancelled subscription, dead id)", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled',
                     trial_used_at = now() - interval '30 days'
               where org_id = ${orgId}`;

    await restoreTrial(actorId, orgId, "departed customer, giving them another shot");
    const [row] = await sql<{ trial_used_at: string | null }[]>`
      select trial_used_at from subscriptions where org_id = ${orgId}`;
    expect(row.trial_used_at).toBeNull();
  });

  it("restoring a trial for an org with no subscription row throws 404", async () => {
    const s = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"No Sub " + s}, ${"no-sub-" + s}) returning id`;
    const { actorId } = await seedOrg();
    await expect(restoreTrial(actorId, orgId, "reason")).rejects.toThrow(/subscription row/i);
  });

  // The admin panel needs trial_used_at to show whether Restore trial has
  // anything to do — planPanel must actually select it, not just carry the
  // field in its type.
  it("planPanel exposes trial_used_at, including on a departed org that still shows a Pro plan_key", async () => {
    const { orgId, actorId } = await seedOrg();
    expect((await planPanel(orgId)).trial_used_at).toBeNull();

    await extendTrial(actorId, orgId, 7, "trial for the summary");
    const { trial_used_at: stamped } = await planPanel(orgId);
    expect(stamped).not.toBeNull();

    // Depart the org (cancelled subscription, dead id) while leaving plan_key
    // at pro — planPanel must keep reporting the real trial_used_at rather
    // than nulling it out because the subscription looks dead.
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_gone', status = 'canceled', plan_key = 'pro'
               where org_id = ${orgId}`;
    const departed = await planPanel(orgId);
    expect(departed.status).toBe("canceled");
    expect(departed.plan_key).toBe("pro");
    expect(departed.trial_used_at).toEqual(stamped);
  });

  // planPanel is ALSO the shared "before" snapshot read by compToPro,
  // adminDowngrade and extendTrial on every single invocation — none of them
  // ever look at cards, so planPanel must stay a pure DB reader. Proven with
  // a customer id actually on the row (the one case that would have reached
  // Stripe before this fix); an org with no customer id was never the bug.
  it("planPanel makes no Stripe calls, even for an org with a stripe_customer_id", async () => {
    const { orgId } = await seedOrg();
    await sql`update subscriptions set stripe_customer_id = 'cus_test123' where org_id = ${orgId}`;

    await planPanel(orgId);

    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.listPaymentMethods).not.toHaveBeenCalled();

    // Same call, exercised through one of planPanel's actual callers — proves
    // this isn't just true of the direct call above.
    await compToPro((await seedOrg()).actorId, orgId, null, "reason");
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.listPaymentMethods).not.toHaveBeenCalled();
  });

  it("planPanel's no-subscription-row default reports trial_used_at: null (not undefined)", async () => {
    const s = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"No Sub TU " + s}, ${"no-sub-tu-" + s}) returning id`;
    const panel = await planPanel(orgId);
    expect(panel.source).toBe("none");
    expect(panel.trial_used_at).toBeNull();
  });
});

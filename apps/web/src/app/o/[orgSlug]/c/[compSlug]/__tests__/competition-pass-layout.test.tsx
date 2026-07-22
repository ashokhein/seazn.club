// The competition layout's one job (v3/07 §3, task 16): answer "does this org
// hold an Event Pass for the competition in the URL?" from the slugs alone, and
// hand the answer to the client subtree.
//
// The load-bearing case is the STAFF GRANT. `competition_passes` (V271) is five
// columns and `stripe_payment_intent` is NULLABLE, so a pass granted by support
// carries no intent and is still fully active. Presence is about the ROW
// EXISTING; a layout that filtered on the intent would re-sell a pass the org
// already owns, which is the exact failure this state exists to prevent.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { sql } from "@/lib/db";
import { invalidateSlugCache } from "@/server/slug-resolve";
import {
  usePassActive,
  usePassGateState,
} from "@/components/competition-pass-provider";
import CompetitionLayout from "../layout";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

function Probe() {
  return (
    <span id="p">{`pass:${usePassActive()} state:${usePassGateState()}`}</span>
  );
}

/** Render the layout exactly as Next would: `params` arrives as a PROMISE. */
async function renderLayout(orgSlug: string, compSlug: string): Promise<string> {
  const element = await CompetitionLayout({
    children: <Probe />,
    params: Promise.resolve({ orgSlug, compSlug }),
  });
  return renderToStaticMarkup(element);
}

interface Rig {
  orgId: string;
  orgSlug: string;
  compId: string;
  compSlug: string;
}

async function seed(): Promise<Rig> {
  const s = uniq();
  const orgSlug = "pass-layout-org-" + s;
  const compSlug = "pass-layout-cup-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pass Layout Org " + s}, ${orgSlug})
    returning id`;
  await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Pass Layout Cup " + s}, ${compSlug}, 'unlisted') returning id`;
  // The slug resolvers cache-through Redis; a fresh row under a run-unique slug
  // can only collide with itself, but clear it so a re-run never reads a miss
  // cached by an earlier failure.
  await invalidateSlugCache("org", null, orgSlug);
  await invalidateSlugCache("competition", orgId, compSlug);
  return { orgId, orgSlug, compId, compSlug };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("competition layout provides Event Pass state", () => {
  it("is false for a competition with no pass", async () => {
    const rig = await seed();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:false");
  });

  it("is true once a purchased pass exists", async () => {
    const rig = await seed();
    // RED without the layout: no provider mounts, usePassActive() falls back to
    // its `false` default, and Task 17's gate re-sells a pass already bought.
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${rig.compId}, ${rig.orgId}, ${"pi_" + uniq()})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
  });

  it("is true for a STAFF-GRANTED pass, whose stripe_payment_intent is null", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    const [row] = await sql<{ stripe_payment_intent: string | null }[]>`
      select stripe_payment_intent from competition_passes
      where competition_id = ${rig.compId}`;
    // Guards the premise: if this column ever stops being nullable the case
    // below is no longer testing what its name claims.
    expect(row.stripe_payment_intent).toBeNull();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
  });

  it("is false when the pass belongs to a SIBLING competition in the same org", async () => {
    // A pass unlocks ONE competition. Resolving org-wide is the bug this whole
    // branch keeps re-fixing, so the layout has to be competition-scoped.
    const rig = await seed();
    const s = uniq();
    const otherSlug = "pass-layout-other-" + s;
    const [{ id: otherId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility)
      values (${rig.orgId}, ${"Other Cup " + s}, ${otherSlug}, 'unlisted') returning id`;
    await invalidateSlugCache("competition", rig.orgId, otherSlug);
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;

    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("pass:true");
    expect(await renderLayout(rig.orgSlug, otherSlug)).toContain("pass:false");
    expect(otherId).not.toBe(rig.compId);
  });

  it("reports 'paid_plan' for a Pro org, so no gate offers it the $29 pass", async () => {
    // Task 17's deferred row. A Pro org has no pass ROW, so the boolean read
    // false and the gate sold them a pass granting LESS than they hold (10 AI
    // runs per division vs Pro's 20; 64 entrants vs 256).
    const rig = await seed();
    await sql`update subscriptions set plan_key = 'pro', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("pass:false");
    expect(html).toContain("state:paid_plan");
  });

  it("reports 'paid_plan' for a trialing org — a trial is a paid plan", async () => {
    // 'trialing' is in LIVE_SUBSCRIPTION_STATUSES and carries the Pro matrix.
    const rig = await seed();
    await sql`update subscriptions set plan_key = 'pro', status = 'trialing'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:paid_plan");
  });

  it("reports 'paid_plan' for a STAFF-COMPED org whose comp has not lapsed", async () => {
    // A comp conveys the plan with no Stripe subscription at all, so anything
    // testing stripe_subscription_id (hasLiveSubscription) would call this org
    // unpaid and keep selling it the pass.
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'active', stripe_subscription_id = null,
                  comped_until = now() + interval '30 days'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:paid_plan");
  });

  it("reports 'paid_plan' for past_due INSIDE the 14-day grace", async () => {
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'past_due', status_changed_at = now()
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:paid_plan");
  });

  it("reports 'none' for a LAPSED comp — the pass genuinely lifts them again", async () => {
    // The other direction, and why this reads the resolver's plan rather than
    // subscriptions.plan_key raw: a lapsed comp resolves as community, so the
    // pass arm in lib/entitlements.ts fires for it and $29 buys real headroom.
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'active', stripe_subscription_id = null,
                  comped_until = now() - interval '1 day'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:none");
  });

  it("reports 'none' for past_due BEYOND the grace window", async () => {
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'past_due',
                  status_changed_at = now() - interval '20 days'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:none");
  });

  it("reports 'none' for an org with no subscriptions row at all", async () => {
    const rig = await seed();
    // V314: unlink the org from its group so the resolver's LEFT JOIN finds
    // nothing — the same "no subscription" state, now that org points at sub.
    await sql`update organizations set subscription_id = null where id = ${rig.orgId}`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:none");
  });

  it("prefers the plan over a pass the org bought before upgrading", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    await sql`update subscriptions set plan_key = 'pro_plus', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    // The row is still reported honestly; the gate state is not.
    expect(html).toContain("pass:true");
    expect(html).toContain("state:paid_plan");
  });

  it("is false — and still renders children — for an unresolvable slug", async () => {
    // The child page owns the 404 / rename redirect. The layout must not
    // pre-empt it, and must not throw on the way past.
    const rig = await seed();
    const html = await renderLayout(rig.orgSlug, "no-such-competition-" + uniq());
    expect(html).toContain("pass:false");
    expect(html).toContain("<span");
  });
});

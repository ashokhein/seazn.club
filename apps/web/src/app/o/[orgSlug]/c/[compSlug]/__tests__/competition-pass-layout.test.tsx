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
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

// The layout resolves the org's CURRENCY as well (v17 #294), and
// `preferredCurrency` reads `cookies()` / `headers()`. In production this runs
// inside a request; called directly from a test it throws "`cookies` was called
// outside a request scope". A minimal empty request scope is all it needs — and
// EMPTY is the case that matters here, because it makes the org's subscription
// currency the only thing that can decide the answer, which is exactly the
// precedence the assertions below rely on.
const requestHeaders = vi.hoisted(() => ({ acceptLanguage: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (k: string) => (k === "accept-language" ? requestHeaders.acceptLanguage : null) }),
}));

import { sql } from "@/lib/db";
import { invalidateSlugCache } from "@/server/slug-resolve";
import {
  usePassActive,
  usePassCurrency,
  usePassGateState,
  usePassLockReason,
  usePassRung,
  usePassSellableRungs,
} from "@/components/competition-pass-provider";
import CompetitionLayout from "../layout";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

function Probe() {
  return (
    <span id="p">
      {`pass:${usePassActive()} state:${usePassGateState()} rung:${usePassRung()} currency:${usePassCurrency()} reason:${usePassLockReason()} sellable:${usePassSellableRungs().join("+") || "none"}`}
    </span>
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

  // v17 #327 rewrote what "a paid plan" means here. It used to mean "no pass is
  // offered at all", on the premise that Pro was a superset of every rung. The L
  // rung ended that: L lifts Pro's 256-entrant ceiling, so a Pro org is offered
  // L — and ONLY L. These four cases therefore assert on `sellable`, which is
  // the sharper discriminator: a plan that resolved as COMMUNITY would report
  // both rungs, so "event_pass_l" alone proves the resolver read Pro AND that
  // the $29 rung is not on sale to them.
  it("offers a Pro org the L rung only — never the $29 pass it already covers", async () => {
    const rig = await seed();
    await sql`update subscriptions set plan_key = 'pro', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("pass:false");
    expect(html).toContain("sellable:event_pass_l");
    expect(html).toContain("state:none");
  });

  it("offers NOTHING to Pro Plus, which really is a superset", async () => {
    // The case the four below were always about, now that Pro is not it: Pro
    // Plus caps nothing either rung lifts, so no pass is for sale and the gate
    // goes quiet exactly as it did before #327.
    const rig = await seed();
    await sql`update subscriptions set plan_key = 'pro_plus', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("sellable:none");
    expect(html).toContain("state:paid_plan");
  });

  it("reads a trialing org as paid — a trial carries the Pro matrix", async () => {
    // 'trialing' is in LIVE_SUBSCRIPTION_STATUSES and carries the Pro matrix, so
    // the M rung must not be for sale.
    const rig = await seed();
    await sql`update subscriptions set plan_key = 'pro', status = 'trialing'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("sellable:event_pass_l");
  });

  it("reads a STAFF-COMPED org whose comp has not lapsed as paid", async () => {
    // A comp conveys the plan with no Stripe subscription at all, so anything
    // testing stripe_subscription_id (hasLiveSubscription) would call this org
    // unpaid and put the $29 rung back on sale.
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'active', stripe_subscription_id = null,
                  comped_until = now() + interval '30 days'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("sellable:event_pass_l");
  });

  it("reads past_due INSIDE the 14-day grace as paid", async () => {
    const rig = await seed();
    await sql`update subscriptions
              set plan_key = 'pro', status = 'past_due', status_changed_at = now()
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("sellable:event_pass_l");
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

  // v17 gap #301. The layout's pass read was `select pass_key ... limit 1` —
  // row existence and nothing else — so a pass the resolver had ALREADY
  // stopped honouring (terminal status, or past ends_on + grace) reached every
  // island underneath looking exactly like a live one. The join to
  // `competitions` is what makes the difference visible; `passLockReason` is
  // the only thing allowed to judge it.
  it("is 'ended' when the pass exists but its competition is archived", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    await sql`update competitions set status = 'archived' where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    // The ROW is still reported honestly — the org did buy a pass, and it is
    // never re-sold. Only the gate state changes.
    expect(html).toContain("pass:true");
    expect(html).toContain("state:ended");
    expect(html).toContain("reason:terminal");
  });

  it("is 'ended' when the pass's competition is completed", async () => {
    // The other half of the terminal set, and the one an organiser actually
    // reaches: finishing a competition writes 'completed'.
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    await sql`update competitions set status = 'completed' where id = ${rig.compId}`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:ended");
  });

  it("is 'ended' when the pass's competition ended beyond the grace window", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    await sql`update competitions set status = 'live', ends_on = ${eightDaysAgo}
              where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    // The reason distinguishes it from the terminal case above — the two get
    // different wording and different CTAs downstream, so a boolean here would
    // pass the state assertion and still lose what Tasks 3-6 need.
    expect(html).toContain("state:ended");
    expect(html).toContain("reason:past_ends_on");
  });

  it("stays 'held' — not 'ended' — inside the grace window", async () => {
    // The control arm for both cases above: a still-running competition, and a
    // recently-ended one, must keep reading exactly as they do today.
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await sql`update competitions set status = 'live', ends_on = ${threeDaysAgo}
              where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("state:held");
    expect(html).toContain("reason:null");
  });

  it("stays 'held' for a live competition with no end date at all", async () => {
    // `ends_on` is nullable in the database and stays that way, but since #376
    // made it mandatory at create — and non-nullable on PATCH — the API can no
    // longer produce a null. The case is still real, and still worth pinning,
    // because the column outlives the schema that writes it: every competition
    // created before #376 kept whatever it had, and nothing backfills them. So
    // the read must keep handling null even though no new row can carry one.
    // If the join or the null handling were wrong, this is the case that would
    // flip those rows to "ended" at once.
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    await sql`update competitions set status = 'live', ends_on = null
              where id = ${rig.compId}`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:held");
  });

  it("prefers 'paid_plan' over an ended pass", async () => {
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id)
              values (${rig.compId}, ${rig.orgId})`;
    await sql`update competitions set status = 'completed' where id = ${rig.compId}`;
    await sql`update subscriptions set plan_key = 'pro', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("state:paid_plan");
  });

  // #376. The whole defect in one case: the read INNER-joined `competitions`
  // through `competition_passes`, so a competition that had never been sold a
  // pass produced NO ROW — `status` and `ends_on` were never fetched and
  // `passLockReason` could not be called even in principle. The reason came
  // back null for every unsold competition on the product, whatever its status,
  // and the gate then offered a $29 checkout the route answers with 410 Gone.
  it("reports a lock for a competition that never held a pass (#376 regression)", async () => {
    const rig = await seed();
    await sql`update competitions set status = 'archived' where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    // The assertion that was impossible before the LEFT JOIN: a lock reason
    // standing beside a null pass key.
    expect(html).toContain("reason:terminal");
    expect(html).toContain("pass:false");
    expect(html).toContain("rung:null");
    expect(html).toContain("state:closed");
    // Nothing is for sale past the line, so the rung column may not advertise
    // one. Before the change this read `event_pass+event_pass_l`.
    expect(html).toContain("sellable:none");
  });

  it("reports the same lock for a COMPLETED competition with no pass", async () => {
    // The terminal arm an organiser actually reaches — finishing a competition
    // writes 'completed', and nobody has to archive anything for the offer to
    // become a refusal.
    const rig = await seed();
    await sql`update competitions set status = 'completed' where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("reason:terminal");
    expect(html).toContain("state:closed");
    expect(html).toContain("sellable:none");
  });

  it("reports past_ends_on for an unsold competition beyond the grace window", async () => {
    // The date arm, and the reason is load-bearing: this organiser's only
    // problem may be a stale end date, so the two arms get different wording
    // and different CTAs downstream. A boolean here would lose that.
    const rig = await seed();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    await sql`update competitions set status = 'live', ends_on = ${eightDaysAgo}
              where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("pass:false");
    expect(html).toContain("reason:past_ends_on");
    expect(html).toContain("state:closed");
    expect(html).toContain("sellable:none");
  });

  it("still reports no lock for a live competition with no pass", async () => {
    // The control arm for all three above. Without it they would still pass if
    // the layout simply declared every unsold competition closed, which would
    // silence the $29 offer across the entire product.
    const rig = await seed();
    await sql`update competitions set status = 'live', ends_on = null
              where id = ${rig.compId}`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("reason:null");
    expect(html).toContain("state:none");
    expect(html).toContain("sellable:event_pass+event_pass_l");
  });

  it("prefers 'paid_plan' over a closed competition with no pass", async () => {
    // The plan still wins over everything: a Pro Plus org's gate was closed by
    // its PLAN's ceiling, and `closed` would name the wrong limit.
    const rig = await seed();
    await sql`update competitions set status = 'completed' where id = ${rig.compId}`;
    await sql`update subscriptions set plan_key = 'pro_plus', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("pass:false");
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

// v17 #294. The layout is the ONLY place that can answer either of these:
// `pass_key` is a column, and `preferredCurrency` reads the org's subscription,
// a cookie and a header. Every client island under it was guessing — the
// paywall in hardcoded usd, the held signals in the product FAMILY's name.
describe.skipIf(!HAS_DB)("competition layout provides the rung and the currency", () => {
  it("carries null for a competition with no pass", async () => {
    const rig = await seed();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("rung:null");
  });

  it("carries the rung the competition actually holds, both ways round", async () => {
    // Both arms and two separate competitions: "L reads L" proves nothing if
    // the layout answers L to everything, and the M arm is what a pre-#294
    // build would still pass.
    for (const rung of ["event_pass", "event_pass_l"] as const) {
      const rig = await seed();
      await sql`insert into competition_passes (competition_id, org_id, pass_key)
                values (${rig.compId}, ${rig.orgId}, ${rung})`;
      expect(await renderLayout(rig.orgSlug, rig.compSlug), rung).toContain(`rung:${rung}`);
    }
  });

  it("keeps reporting the rung under a paid plan", async () => {
    // usePassRung answers the ROW's question, like usePassActive. The
    // "should we advertise it" precedence stays in usePassGateState.
    const rig = await seed();
    await sql`insert into competition_passes (competition_id, org_id, pass_key)
              values (${rig.compId}, ${rig.orgId}, 'event_pass_l')`;
    await sql`update subscriptions set plan_key = 'pro', status = 'active'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    const html = await renderLayout(rig.orgSlug, rig.compSlug);
    expect(html).toContain("state:paid_plan");
    expect(html).toContain("rung:event_pass_l");
  });

  it("resolves the currency from the org's own subscription", async () => {
    // The precedence `preferredCurrency` defines: a live subscription currency
    // beats the switcher cookie and the header guess, because a renewal never
    // switches currency. With the jar and the header empty, this is the only
    // input — so a layout that shipped a constant would fail here.
    const rig = await seed();
    await sql`update subscriptions set currency = 'gbp'
              where id = (select subscription_id from organizations where id = ${rig.orgId})`;
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("currency:gbp");
  });

  it("falls back to usd when the org has nothing to resolve from", async () => {
    // Today's behaviour for every org without a currency on file — and what
    // the paywall hardcoded for ALL of them before this change.
    const rig = await seed();
    expect(await renderLayout(rig.orgSlug, rig.compSlug)).toContain("currency:usd");
  });
});

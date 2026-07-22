// The pass-checkout route refuses a paid org — "Your plan already covers
// everything an Event Pass adds." It used to decide that from the raw
// `subscriptions.plan_key` column, which keeps saying 'pro' after a comp lapses
// or a subscription is cancelled. So a lapsed org was told its plan covered the
// pass when it no longer did, and was blocked from a purchase it was entitled to
// make. Task 21 then made the upgrade page render from `orgPlanKey`, which
// applies those read-time degradations — leaving a visible buy button that 400s.
//
// The route now judges eligibility through the same resolver as the page, so
// there is one answer to "is this org on a paid plan".
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn().mockResolvedValue({ client_secret: "cs_secret_test" });
  return { checkoutCreate, stripe: { checkout: { sessions: { create: checkoutCreate } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const authState = vi.hoisted(() => ({
  orgId: null as string | null,
  user: {
    id: "d0d0d0d0-0000-4000-8000-000000000009",
    display_name: "Gate Owner",
    email: "gate-owner@test.local",
    avatar_url: null,
    timezone: null as string | null,
    locale: null as string | null,
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getActiveOrgId: vi.fn(async () => authState.orgId),
  requireOrgRole: vi.fn(async () => ({ user: authState.user, role: "owner" as const })),
}));

import { sql } from "@/lib/db";
import { POST as passCheckoutPOST } from "@/app/api/billing/pass-checkout/route";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Gate Org " + suffix}, ${"gate-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Gate Cup " + suffix}, ${"gate-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

const req = (competitionId: string) =>
  new Request("http://test.local/api/billing/pass-checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ competition_id: competitionId }),
  });

// `plans` is global; the route 503s without a one-time price id. Capture and
// restore it — the shared dev DB is the same database, and leaving a stub here
// breaks local Event Pass checkout for everyone (see billing-pass-duplicate).
let priorOnetime: string | null = null;
let captured = false;

afterAll(async () => {
  if (!HAS_DB || !captured) return;
  await sql`update plans set stripe_price_id_onetime = ${priorOnetime}
            where key = 'event_pass'`;
});

beforeEach(() => stripeMock.checkoutCreate.mockClear());

describe.skipIf(!HAS_DB)("pass-checkout eligibility uses the resolver, not raw plan_key", () => {
  const givePrice = async () => {
    if (!captured) {
      const [prior] = await sql<{ id: string | null }[]>`
        select stripe_price_id_onetime as id from plans where key = 'event_pass'`;
      priorOnetime = prior?.id ?? null;
      captured = true;
    }
    await sql`update plans set stripe_price_id_onetime = 'price_test_pass'
              where key = 'event_pass'`;
  };

  it("lets an org whose COMP HAS LAPSED buy a pass, though plan_key still says pro", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    // The row still reads 'pro'. `comped_until` is in the past, so the resolver
    // degrades the org to community — and a community org may buy a pass.
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency, comped_until)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active', 'usd', now() - interval '1 day' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(200);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("still refuses an org on a genuinely live paid plan", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active', 'usd' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(400);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("still lets a plain community org buy", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(200);
  });
});

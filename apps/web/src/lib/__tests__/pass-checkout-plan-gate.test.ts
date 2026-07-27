// The pass-checkout route refuses a paid org — "Your plan already includes
// every Event Pass feature." It used to decide that from the raw
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
import type Stripe from "stripe";

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

const req = (competitionId: string, body?: Record<string, unknown>) =>
  new Request("http://test.local/api/billing/pass-checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ competition_id: competitionId, ...body }),
  });

// `plans` is global; the route 503s without a one-time price id. Capture and
// restore it — the shared dev DB is the same database, and leaving a stub here
// breaks local Event Pass checkout for everyone (see billing-pass-duplicate).
let priorOnetime: string | null = null;
let captured = false;
// v17 #294: the L rung's one-time price is a SECOND global row this file now
// stubs, and it needs the same capture/restore discipline.
let priorOnetimeL: string | null = null;
let capturedL = false;

afterAll(async () => {
  if (!HAS_DB) return;
  if (captured) {
    await sql`update plans set stripe_price_id_onetime = ${priorOnetime}
              where key = 'event_pass'`;
  }
  if (capturedL) {
    await sql`update plans set stripe_price_id_onetime = ${priorOnetimeL}
              where key = 'event_pass_l'`;
  }
});

beforeEach(() => stripeMock.checkoutCreate.mockClear());

/** Stub M's one-time price id, capturing the real one first. `price_test_pass`
 *  is the literal the sibling pass-checkout suites use too, so a concurrent
 *  worker writing the same global row writes the same value. */
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

/** Same for L (v17 #294). `null` models an environment where `stripe:sync` has
 *  not pushed the rung's price yet. */
const giveLPrice = async (priceId: string | null) => {
  if (!capturedL) {
    const [prior] = await sql<{ id: string | null }[]>`
      select stripe_price_id_onetime as id from plans where key = 'event_pass_l'`;
    priorOnetimeL = prior?.id ?? null;
    capturedL = true;
  }
  await sql`update plans set stripe_price_id_onetime = ${priceId}
            where key = 'event_pass_l'`;
};

describe.skipIf(!HAS_DB)("pass-checkout eligibility uses the resolver, not raw plan_key", () => {

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

// v17 #294 — the route must buy the rung the caller ASKED for. Before this it
// hardcoded `where key = 'event_pass'` for the price AND `pass_key: "event_pass"`
// in the session metadata, so L was unbuyable; and had either half been widened
// without the other, the buyer would be charged one rung's price and entitled to
// the other's caps.
//
// Lives in this file rather than its own so it shares ONE capture/restore of the
// global `plans` price ids: vitest runs files in parallel workers, and a second
// file stubbing the same rows races this one.
describe.skipIf(!HAS_DB)("pass-checkout buys the rung it was asked for (v17 #294)", () => {
  /** A community org with a competition, eligible to buy either rung. The
   *  subscription's `currency` is not decoration: without it preferredCurrency
   *  falls through to next/headers `cookies()`, which throws outside a request
   *  scope and 500s the route. */
  const seedBuyer = async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('rungowner-' || gen_random_uuid() || '@test.local', 'Rung Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd'
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;
    // Both rungs priced, with DISTINCT ids — identical stubs would pass against
    // the old hardcoded lookup and prove nothing.
    await givePrice();
    await giveLPrice("price_test_pass_l");
    return { orgId, compId };
  };

  const createdParams = (n = 0) =>
    stripeMock.checkoutCreate.mock.calls[n]![0] as Stripe.Checkout.SessionCreateParams;
  const createdKey = (n = 0) =>
    (stripeMock.checkoutCreate.mock.calls[n]![1] as { idempotencyKey: string }).idempotencyKey;

  it("defaults to M when the body names no rung (every pre-#294 client)", async () => {
    const { compId } = await seedBuyer();

    expect((await passCheckoutPOST(req(compId))).status).toBe(200);
    expect(createdParams().line_items).toEqual([{ price: "price_test_pass", quantity: 1 }]);
    expect(createdParams().metadata).toMatchObject({ pass_key: "event_pass" });
  });

  it("buys L off L's own price id and stamps L into the metadata", async () => {
    const { orgId, compId } = await seedBuyer();

    expect((await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }))).status).toBe(200);
    // Price and metadata must move TOGETHER: L's price with M's metadata charges
    // $59 for M's caps, and the reverse charges $29 for L's.
    expect(createdParams().line_items).toEqual([{ price: "price_test_pass_l", quantity: 1 }]);
    expect(createdParams().metadata).toEqual({
      org_id: orgId,
      competition_id: compId,
      pass_key: "event_pass_l",
    });
    // The buyer's invoice names the rung too — both rungs otherwise render as
    // identical lines on the billing page, differing only in amount.
    expect(createdParams().invoice_creation?.invoice_data?.description).toMatch(/^Event Pass L — /);
  });

  it("503s on a rung whose price has not reached this environment yet", async () => {
    const { compId } = await seedBuyer();
    // stripe:sync has not been run here, so L has no one-time price id. Falling
    // back to M's would charge $29 for L's caps.
    await giveLPrice(null);

    expect((await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }))).status).toBe(503);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("rejects a rung that is not a pass key at all", async () => {
    const { compId } = await seedBuyer();

    for (const bogus of ["event_pass_xl", "pro", ""]) {
      const res = await passCheckoutPOST(req(compId, { pass_key: bogus }));
      expect(res.status, `pass_key=${JSON.stringify(bogus)} must not be accepted`).toBe(400);
    }
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("scopes the idempotency key by rung, so switching M→L mints a NEW session", async () => {
    const { compId } = await seedBuyer();

    await passCheckoutPOST(req(compId, { pass_key: "event_pass" }));
    // The same owner changes their mind before completing checkout. Without the
    // rung in the key, Stripe sees a key reuse with DIFFERENT params (a different
    // price) and 400s — the buyer is stuck on the rung they first clicked.
    await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }));

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(createdKey(0)).not.toBe(createdKey(1));
    expect(createdKey(0).endsWith("-event_pass")).toBe(true);
    expect(createdKey(1).endsWith("-event_pass_l")).toBe(true);
  });
});

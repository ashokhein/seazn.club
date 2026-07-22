// P0-3b (payments hardening): two owners — or one double-click / two tabs —
// can both pay for the same competition's Event Pass. The pass is keyed by
// competition_id, so the first insert wins and the SECOND payment used to be
// silently kept. recordPassPurchase now reports the losing intent so the
// checkout/webhook path sends it straight back (registrations' duplicate
// contract). A REPLAY of the same intent (webhook + reconcile racing on ONE
// payment) is not a duplicate and must never trigger a refund.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// The duplicate refund and the checkout-session mint are the only Stripe calls
// on these paths; spy on both without a live network (sibling convention:
// registrations.test.ts).
const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  const checkoutCreate = vi.fn().mockResolvedValue({ client_secret: "cs_secret_test" });
  return {
    refundCreate,
    checkoutCreate,
    stripe: {
      refunds: { create: refundCreate },
      checkout: { sessions: { create: checkoutCreate } },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// Route-level auth is stubbed (no cookie/JWT in a unit test): getActiveOrgId
// hands back the seeded org and requireOrgRole the requesting owner — the id
// the per-user idempotency key is built from. Everything else the route does
// (DB reads, buildPassCheckoutParams) runs for real. Same pattern as
// app/api/orgs/[id]/__tests__/route.test.ts.
const authState = vi.hoisted(() => ({
  orgId: null as string | null,
  user: {
    id: "d0d0d0d0-0000-4000-8000-000000000001",
    display_name: "Dup Owner",
    email: "dup-owner@test.local",
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
import { recordPassPurchase } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { POST as passCheckoutPOST } from "@/app/api/billing/pass-checkout/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** A paid, pass-shaped checkout.session.completed event as the webhook /
 *  replay path sees it. */
const passCheckoutEvent = (orgId: string, competitionId: string, intent: string) =>
  ({
    type: "checkout.session.completed",
    data: {
      object: {
        metadata: { org_id: orgId, competition_id: competitionId, pass_key: "event_pass" },
        payment_status: "paid",
        payment_intent: intent,
      },
    },
  }) as unknown as Stripe.Event;

/** Sibling-suite seeding style (billing-pass-revoke): a fresh org + competition,
 *  the only two FK parents a competition_passes row needs. */
async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Dup Org " + suffix}, ${"dup-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Dup Cup " + suffix}, ${"dup-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

beforeEach(() => {
  stripeMock.refundCreate.mockClear();
  stripeMock.checkoutCreate.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("recordPassPurchase duplicates", () => {
  it("first purchase records; second DIFFERENT intent reports a duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    const a = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(a).toEqual({ recorded: true, duplicateIntent: null });
    const b = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_b" });
    expect(b).toEqual({ recorded: false, duplicateIntent: "pi_b" });
    const same = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(same).toEqual({ recorded: false, duplicateIntent: null }); // replay, not duplicate
  });

  it("a null-intent second purchase reports no refundable duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_first" });
    // Reconcile-on-return passes null when the session's intent isn't a string;
    // there is nothing to refund, so it must not be reported as a duplicate.
    const res = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: null });
    expect(res).toEqual({ recorded: false, duplicateIntent: null });
  });

  it("two concurrent purchases: exactly one records, the other is a refundable duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    // Two webhooks / a double-click racing on ONE comp. The competition_id
    // primary key serialises them: exactly one wins, and the loser reports ITS
    // OWN intent (a real second charge) so it can be sent back — never null,
    // never two records.
    const results = await Promise.all(
      ["pi_race_a", "pi_race_b"].map((intent) =>
        recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent }).then((r) => ({
          intent,
          r,
        })),
      ),
    );
    const winners = results.filter((x) => x.r.recorded);
    const losers = results.filter((x) => !x.r.recorded);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].r.duplicateIntent).toBeNull();
    expect(losers[0].r.duplicateIntent).toBe(losers[0].intent);
  });
});

describe.skipIf(!HAS_DB)("Event Pass duplicate payment → auto-refund (checkout dispatch)", () => {
  it("refunds a duplicate charge with an idempotency key; the original pass is untouched", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    // First owner already paid — pass recorded under pi_first.
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_first" });
    stripeMock.refundCreate.mockClear();

    // Second owner's checkout completes for the same, already-passed comp.
    await processStripeEvent(passCheckoutEvent(orgId, compId, "pi_second"));

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_second" },
      { idempotencyKey: "pass-dup-refund-pi_second" },
    );
    // The first payment's pass row is kept as-is.
    const [row] = await sql<{ stripe_payment_intent: string }[]>`
      select stripe_payment_intent from competition_passes where competition_id = ${compId}`;
    expect(row.stripe_payment_intent).toBe("pi_first");
  });

  it("a replay of the SAME intent (webhook + reconcile on one payment) refunds nothing", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_solo" });
    stripeMock.refundCreate.mockClear();

    await processStripeEvent(passCheckoutEvent(orgId, compId, "pi_solo"));

    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("a Stripe refund failure never blocks the webhook ACK", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_keep" });
    stripeMock.refundCreate.mockClear();
    stripeMock.refundCreate.mockRejectedValueOnce(new Error("stripe unavailable"));

    // The dispatch must resolve (never throw) so processed_at is still stamped.
    await expect(processStripeEvent(passCheckoutEvent(orgId, compId, "pi_dup"))).resolves.toBeUndefined();
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
  });
});

/** POST /api/billing/pass-checkout with a JSON body, as the client sends it. */
function passCheckoutReq(competitionId: string): Request {
  return new Request("http://localhost/api/billing/pass-checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ competition_id: competitionId }),
  });
}

describe.skipIf(!HAS_DB)("pass-checkout idempotency key is scoped per user (P0-3b)", () => {
  // `plans` is a GLOBAL table — one row per plan, not one per org — so the write
  // inside this test is the only thing in the file that cannot be scoped to rows
  // it seeded. It used to be left behind, and `DATABASE_URL` points at the SHARED
  // dev database: every full `npx vitest run` therefore broke Event Pass checkout
  // in dev afterwards. The route hands this column straight to Stripe, and
  // 'price_test_pass' is not a real price, so every purchase 503'd with
  // "No such price" until someone re-ran `npm run stripe:sync`.
  //
  // Same lesson as commit 3227bd3c: a test may not leave global state changed.
  let priorOnetime: string | null = null;
  let captured = false;

  afterAll(async () => {
    if (!HAS_DB || !captured) return;
    await sql`update plans set stripe_price_id_onetime = ${priorOnetime}
              where key = 'event_pass'`;
  });

  it("keys checkout.sessions.create with pass-checkout-<org>-<comp>-<user>", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    // A community sub carrying a currency short-circuits preferredCurrency BEFORE
    // it reaches next/headers (no request scope in a unit test) and keeps the
    // org pass-eligible (plan_key !== community would reject the pass).
    await sql`insert into subscriptions (org_id, plan_key, status, currency)
              values (${orgId}, 'community', 'active', 'usd')
              on conflict (org_id) do update set plan_key = 'community', currency = 'usd'`;
    // event_pass is a dark plan; its one-time price is written by stripe:sync in
    // real deploys. Capture whatever is there BEFORE overwriting it — on a shared
    // dev DB that is the real, live price id, and afterAll must put it back.
    const [prior] = await sql<{ id: string | null }[]>`
      select stripe_price_id_onetime as id from plans where key = 'event_pass'`;
    priorOnetime = prior?.id ?? null;
    captured = true;
    // Now set a stub so the route can mint a session instead of 503-ing.
    await sql`update plans set stripe_price_id_onetime = 'price_test_pass'
              where key = 'event_pass'`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(passCheckoutReq(compId));
    expect(res.status).toBe(200);

    // The SECOND argument is the Stripe idempotency options. Pinning it to the
    // requesting user lets two DIFFERENT owners racing one comp mint DISTINCT
    // sessions (an org+comp-only key would 400 on their per-user customer_email
    // param mismatch) while a double-click still dedups. This fails if the key
    // drops the userId or otherwise changes shape.
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkoutCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: `pass-checkout-${orgId}-${compId}-${authState.user.id}`,
    });
  });
});

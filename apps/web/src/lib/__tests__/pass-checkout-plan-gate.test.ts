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
  // v17 gap #326: the MINT guard reads the session's line items back off
  // Stripe. Its suite lives in this file for the reason the second describe
  // below spells out — one capture/restore of the global `plans` price ids.
  const listLineItems = vi.fn();
  const retrieve = vi.fn();
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  return {
    checkoutCreate,
    listLineItems,
    retrieve,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate, listLineItems, retrieve } },
      refunds: { create: refundCreate },
      paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// PARTIAL mock: lib/billing.ts and billing-events.ts import a dozen other
// senders from this module and a full replacement breaks them.
const emailMock = vi.hoisted(() => ({
  sendPassRungMismatchAlertEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPassRungMismatchAlertEmail: emailMock.sendPassRungMismatchAlertEmail,
}));

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
import { maybeAlertPassRungMismatch, reconcilePassCheckout } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { balance, walletIdFor } from "@/lib/credits";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";

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

beforeEach(() => {
  stripeMock.checkoutCreate.mockClear();
  stripeMock.listLineItems.mockClear();
  stripeMock.retrieve.mockClear();
  stripeMock.refundCreate.mockClear();
  emailMock.sendPassRungMismatchAlertEmail.mockClear();
});

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

// v17 gap #326 — the MINT guard. The suite above proves the checkout ROUTE
// builds a session whose price and metadata agree. Nothing checked it again
// after the sale: both mint paths (reconcilePassCheckout and the webhook) took
// the rung from `session.metadata.pass_key` and never compared it against the
// price the buyer was actually charged. A desync — a stale `stripe:sync`, a
// price id edited in the Dashboard, a future third rung wired to the wrong
// lookup key — therefore produced a customer who paid $29 and held the $59 rung
// (or the reverse) with no error, no failing test and nothing in the data to
// find it by afterwards. The two witnesses that DO catch it
// (e2e/event-pass.spec.ts and pass-checkout-l.live.test.ts) are both opt-in and
// neither runs in CI, and both look only BEFORE the sale.
//
// Lives in THIS file for the same reason the rung suite does: it stubs the
// global `plans.stripe_price_id_onetime` rows, and vitest runs files in
// parallel workers, so a second file stubbing them races this one.
describe.skipIf(!HAS_DB)("Event Pass mint refuses a rung/price desync (v17 gap #326)", () => {
  /** A community org + competition + the `subscriptions` row every org gets at
   *  creation (lib/auth.ts). A raw `insert into organizations` does not make
   *  one, and the wallet the pass credit lands in is that row. */
  const seedMintBuyer = async (): Promise<{ orgId: string; compId: string }> => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('mintowner-' || gen_random_uuid() || '@test.local', 'Mint Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd'
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    return { orgId, compId };
  };

  /** A PAID pass session as either mint path sees it. `id` is load-bearing here
   *  (unlike the older pass fixtures): the guard reads the line items back BY
   *  session id. `customer: null` keeps linkStripeCustomer out of the way —
   *  this suite is about what is minted, not the money trace. */
  const paidSession = (
    orgId: string,
    compId: string,
    passKey: string,
  ): Stripe.Checkout.Session =>
    ({
      id: "cs_mint_" + randomUUID().slice(0, 8),
      metadata: { org_id: orgId, competition_id: compId, pass_key: passKey },
      payment_status: "paid",
      payment_intent: "pi_mint_" + randomUUID().slice(0, 8),
      customer: null,
      currency: "usd",
    }) as unknown as Stripe.Checkout.Session;

  const passEvent = (session: Stripe.Checkout.Session) =>
    ({ type: "checkout.session.completed", data: { object: session } }) as unknown as Stripe.Event;

  /** What Stripe reports the session was actually BUILT ON. */
  const builtOn = (priceId: string) =>
    stripeMock.listLineItems.mockResolvedValue({ data: [{ price: { id: priceId } }] });

  const passKeyHeld = async (compId: string): Promise<string | null> => {
    const [row] = await sql<{ pass_key: string }[]>`
      select pass_key from competition_passes where competition_id = ${compId}`;
    return row?.pass_key ?? null;
  };

  /** Both rungs priced, with DISTINCT ids — identical stubs would let a guard
   *  that compares nothing look correct. */
  const priceBothRungs = async () => {
    await givePrice(); // event_pass -> 'price_test_pass'
    await giveLPrice("price_test_pass_l");
  };

  // STAFF_ALERT_EMAIL is the first thing every alert wrapper in this codebase
  // checks, so it must be SET for the alert assertions to mean anything — and
  // restored afterwards, because it is process-wide.
  let priorAlertTo: string | undefined;
  const withAlertAddress = () => {
    priorAlertTo = process.env.STAFF_ALERT_EMAIL;
    process.env.STAFF_ALERT_EMAIL = "ops@test.local";
  };
  const restoreAlertAddress = () => {
    if (priorAlertTo === undefined) delete process.env.STAFF_ALERT_EMAIL;
    else process.env.STAFF_ALERT_EMAIL = priorAlertTo;
  };

  it("reconcile MINTS when the price paid IS the rung's own price", async () => {
    // The positive discriminator this whole describe rests on: without it, a
    // guard that refused every purchase outright would pass every other test
    // here. It also pins the SILENCE — no console.error, no staff alert —
    // because "did not mint" and "minted quietly" are the two outcomes the
    // negative tests must be told apart from.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass_l");
      stripeMock.retrieve.mockResolvedValue(session);
      builtOn("price_test_pass_l");

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      expect(await balance(await walletIdFor(orgId))).toBe(PASS_CREDIT_GRANT);
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("reconcile REFUSES, grants nothing and alerts staff when the price is the OTHER rung's", async () => {
    // The exact state the W5 review reproduced: the checkout route resolved M's
    // price while stamping L into the metadata. Minting would hand out $59 caps
    // for a $29 charge.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass_l");
      stripeMock.retrieve.mockResolvedValue(session);
      builtOn("price_test_pass"); // M's price, L's metadata

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      // No pass at ANY rung — minting the cheaper one would still be a guess.
      expect(await passKeyHeld(compId)).toBeNull();
      // ...and no credits either: the +25 rides recordPassPurchase, which never ran.
      expect(await balance(await walletIdFor(orgId))).toBe(0);
      // Not silently swallowed as a refund, either — the charge stands and a
      // human decides.
      expect(stripeMock.refundCreate).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();

      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
      expect(emailMock.sendPassRungMismatchAlertEmail.mock.calls[0]![0]).toMatchObject({
        to: "ops@test.local",
        sessionId: session.id,
        orgId,
        competitionId: compId,
        passKey: "event_pass_l",
        expectedPriceId: "price_test_pass_l",
        actualPriceId: "price_test_pass",
        paymentIntent: session.payment_intent,
      });
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("the WEBHOOK mints on a match and refuses the same desync (one guard, two paths)", async () => {
    // Both mint paths, or the guard is a hole wearing a fix: reconcile-on-return
    // usually lands first, but the webhook is the path that runs when the buyer
    // closes the tab.
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = await seedMintBuyer();
      builtOn("price_test_pass");
      await processStripeEvent(passEvent(paidSession(ok.orgId, ok.compId, "event_pass")));
      expect(await passKeyHeld(ok.compId)).toBe("event_pass");
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();

      const bad = await seedMintBuyer();
      builtOn("price_test_pass"); // M's price under L's metadata again
      // ACKs rather than throwing: nothing here is retryable into a better
      // outcome, and a webhook that threw would retry for ever.
      await expect(
        processStripeEvent(passEvent(paidSession(bad.orgId, bad.compId, "event_pass_l"))),
      ).resolves.toBeUndefined();
      expect(await passKeyHeld(bad.compId)).toBeNull();
      expect(await balance(await walletIdFor(bad.orgId))).toBe(0);
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("MINTS unverified, without calling Stripe, when the rung has no configured price", async () => {
    // The deliberate fail-open. Every environment `stripe:sync` has not been run
    // against — including this test database by default — has a NULL
    // stripe_price_id_onetime, and refusing there would break every pass
    // purchase to close an internal-only desync. Checked BEFORE any Stripe call,
    // so the common unconfigured case costs one indexed read.
    const { orgId, compId } = await seedMintBuyer();
    await givePrice();
    await giveLPrice(null);
    withAlertAddress();
    try {
      const session = paidSession(orgId, compId, "event_pass_l");
      stripeMock.retrieve.mockResolvedValue(session);
      // Stubbed to a price that MISMATCHES on purpose: had the guard reached
      // Stripe at all it would have refused, so `toBe(true)` below is a real
      // discriminator rather than a restatement of `not.toHaveBeenCalled()`.
      builtOn("price_that_would_mismatch");

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      expect(stripeMock.listLineItems).not.toHaveBeenCalled();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
    } finally {
      restoreAlertAddress();
    }
  });

  it("the alert is gated on STAFF_ALERT_EMAIL and can never throw at its caller", async () => {
    // The contract every maybeAlert* in this codebase carries, tested DIRECTLY
    // rather than through a caller's catch — which would hide a missing wrapper.
    const opts = {
      sessionId: "cs_alert_probe",
      orgId: "org-probe",
      competitionId: "comp-probe",
      passKey: "event_pass_l" as const,
      expectedPriceId: "price_test_pass_l",
      actualPriceId: "price_test_pass",
      paymentIntent: "pi_probe",
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    priorAlertTo = process.env.STAFF_ALERT_EMAIL;
    try {
      delete process.env.STAFF_ALERT_EMAIL;
      await maybeAlertPassRungMismatch(opts);
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
      // The absence above is only meaningful against a positive: the SAME call
      // with an address configured does send.
      process.env.STAFF_ALERT_EMAIL = "ops@test.local";
      await maybeAlertPassRungMismatch(opts);
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);

      // A dead mailbox must never be what fails a mint the buyer already paid
      // for — and the swallow must be visible in the log, not silent.
      emailMock.sendPassRungMismatchAlertEmail.mockRejectedValueOnce(new Error("mailbox down"));
      await expect(maybeAlertPassRungMismatch(opts)).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });
});

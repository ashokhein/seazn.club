import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { TAG, apiJson, activeOrg, loginUi } from "./helpers";

// Payments-hardening wave — user-visible contract (owner ask 2026-07-18, Task 17).
//
// Every wave change proven through the RUNNING app: where a surface exists we
// assert in the browser; where the trigger is a Stripe event we POST a SIGNED
// synthetic event to the REAL webhook route (/api/webhooks/stripe) and then
// assert the browser-visible (or API/DB, per brief) consequence.
//
// The e2e server runs keyless-ish: STRIPE_WEBHOOK_SECRET=whsec_e2e_payments so
// generateTestHeaderString round-trips through constructEvent, and a DUMMY
// STRIPE_SECRET_KEY so getStripe() (constructEvent needs it) never throws. No
// real Stripe network call is required — every handler either matches by an id
// we seed (payment_intent / customer) or swallows its incidental Stripe call.
// See task-17-report.md for the env wiring.
//
// State is SQL-seeded (mirroring the wave's vitest seeds) with run-unique tags;
// public pages need no auth, session-scoped surfaces log in the seeded org's
// own owner via the magic-link mint. No REDIS in e2e → SQL entitlement flips
// resolve fresh (invalidateOrgEntitlements is an in-process no-op round-trip).

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_e2e_payments";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_e2e_dummy");

/** Run-unique id with a Stripe-style prefix (pi_/ch_/dp_/evt_/cus_/…). */
const uid = (prefix: string) => `${prefix}_${TAG}_${randomBytes(5).toString("hex")}`;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** Community's `entrants.per_division.max` (V311). An Event Pass lifts it to 64
 *  for its own competition, so entry 33 is the boundary that separates a passed
 *  comp (accepted, holds a real spot) from a community one (waitlisted). This is
 *  the grant the pass STILL uniquely provides after V310 made registration.paid
 *  true on every plan — card intake no longer closes on pass/plan loss, so the
 *  old "card payments temporarily unavailable" proof is dead. */
const COMMUNITY_ENTRANT_CAP = 32;

// ---------------------------------------------------------------------------
// Signed-webhook harness (Step 1)
// ---------------------------------------------------------------------------

/** A minimal-but-well-formed Stripe.Event around one object. */
function stripeEvent(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: uid("evt"),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

/** POST a SIGNED event to the real webhook route; returns the raw response. */
async function postSignedEvent(
  request: APIRequestContext,
  event: Record<string, unknown>,
): Promise<import("@playwright/test").APIResponse> {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request.post("/api/webhooks/stripe", {
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    data: payload,
  });
}

// ---------------------------------------------------------------------------
// One-shot SQL against the app's schema (helpers.ts keeps withDb private).
// ---------------------------------------------------------------------------

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// SQL seed helpers (mirror the wave's vitest seeds; run-unique)
// ---------------------------------------------------------------------------

async function ensureSports(sql: import("postgres").Sql): Promise<string> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const [{ module_version }] = await sql<{ module_version: string }[]>`
    select module_version from sports where key = 'generic'`;
  return module_version;
}

interface SeededOrg {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
}

/** Org with its own fresh owner (never the shared Pro user → no budget impact).
 *  plan/connect columns set per opts. Returns ids + the owner email to log in. */
async function seedOrg(opts: {
  plan?: "community" | "pro" | "pro_plus";
  subStatus?: string;
  chargesEnabled?: boolean;
  connected?: boolean;
  payoutsEnabled?: boolean;
  requirementsDue?: number;
  customerId?: string;
  subscriptionId?: string;
  subUpdatedAt?: string;
}): Promise<SeededOrg> {
  const tag = randomBytes(5).toString("hex");
  const ownerEmail = `ph-owner-${TAG}-${tag}@example.com`;
  return withDb(async (sql) => {
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"PH Owner " + tag}, true)
      returning id`;
    const orgSlug = `ph-org-${TAG}-${tag}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations
        (name, slug, status, created_by, stripe_charges_enabled, stripe_account_id,
         stripe_payouts_enabled, stripe_requirements_due)
      values (${"PH Org " + tag}, ${orgSlug}, 'active', ${ownerId},
              ${opts.chargesEnabled ?? false},
              ${opts.connected ? `acct_e2e_${tag}` : null},
              ${opts.payoutsEnabled ?? true},
              ${opts.requirementsDue ?? 0})
      returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    if (opts.plan) {
      // V310: the subscription IS the billing group and the org points at it,
      // rather than the other way round. This seeder builds its org in raw SQL
      // (bypassing createOrgForUser, which would otherwise make the group), so
      // both halves of the link have to be written here — a group with no org
      // pointing at it resolves every entitlement to community.
      const [group] = await sql<{ id: string }[]>`
        insert into subscriptions
          (owner_user_id, plan_key, status, stripe_customer_id, stripe_subscription_id, updated_at)
        values (${ownerId}, ${opts.plan}, ${opts.subStatus ?? "active"},
                ${opts.customerId ?? null}, ${opts.subscriptionId ?? null},
                ${opts.subUpdatedAt ?? new Date().toISOString()})
        returning id`;
      await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    }
    return { orgId, orgSlug, ownerEmail };
  });
}

async function seedComp(
  orgId: string,
  visibility: "public" | "private" | "unlisted" = "public",
): Promise<{ compId: string; compSlug: string }> {
  const tag = randomBytes(5).toString("hex");
  return withDb(async (sql) => {
    const compSlug = `ph-cup-${TAG}-${tag}`;
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions
        (org_id, name, slug, visibility, branding, starts_on, ends_on, discoverable)
      values (${orgId}, ${"PH Cup " + tag}, ${compSlug}, ${visibility},
              ${sql.json({})}, '2026-09-15', '2026-09-20', false)
      returning id`;
    return { compId, compSlug };
  });
}

/** A Stripe-fee registration division on a comp (enabled, £5 card intake).
 *  `capacity` null leaves the PLAN quota (entrants.per_division.max) as the only
 *  ceiling — the entrant-cap tests seed to the community cap and let the pass
 *  overlay decide whether entry 33 holds a spot or waitlists. */
async function seedStripeDivision(
  compId: string,
  capacity: number | null = 20,
): Promise<{ divisionId: string; divisionSlug: string }> {
  const tag = randomBytes(5).toString("hex");
  return withDb(async (sql) => {
    const moduleVersion = await ensureSports(sql);
    const divSlug = `open-${tag}`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions
        (competition_id, name, slug, sport_key, variant_key, config, module_version,
         eligibility, tiebreakers, youth)
      values (${compId}, 'Open', ${divSlug}, 'generic', 'score',
              ${sql.json(GENERIC_CONFIG)}, ${moduleVersion}, ${sql.json([])}, null, false)
      returning id`;
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, currency, refund_lock_at, form_fields, payment_method,
         payment_instructions, updated_at)
      values (${divisionId}, true, 'individual', null, null, ${capacity},
              500, 'gbp', null, ${sql.json([])}, 'stripe', null, now())`;
    return { divisionId, divisionSlug: divSlug };
  });
}

/** Fill a division to `taken` spot-holding entries (status 'pending'), inserted
 *  directly — 32 round-trips through the public endpoint would trip its per-IP
 *  rate limit long before they finished. Mirrors event-pass.spec.ts::fillDivision. */
async function fillDivision(divisionId: string, orgId: string, taken: number): Promise<void> {
  const tag = randomBytes(5).toString("hex");
  await withDb(async (sql) => {
    await sql`
      insert into registrations
        (division_id, org_id, status, display_name, contact_email, ref_code,
         access_token_hash, payment_method)
      select ${divisionId}, ${orgId}, 'pending',
             'Seed ' || g, 'seed-' || g || '-' || ${tag} || '@test.local',
             ${"SZ-" + tag.toUpperCase() + "-"} || lpad(g::text, 4, '0'),
             ${tag + "-"} || g, 'offline'
      from generate_series(1, ${taken}) g`;
  });
}

/** One public registration POST. Returns the HTTP status and the created row's
 *  registration status ('pending' = holds a spot, 'waitlisted' = over the cap).
 *  The card division's checkout mint fails on the seeded fake Connect account and
 *  is swallowed (createRegistrationCheckout try/catch), so a pending entry still
 *  ACKs 201 without any real Stripe call — this stays CI-runnable. */
async function submitPublicRegistration(
  request: APIRequestContext,
  orgSlug: string,
  compSlug: string,
  divisionId: string,
  who: string,
): Promise<{ status: number; data?: { status: string } }> {
  return apiJson<{ status: string }>(
    request,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`,
    "POST",
    {
      division_id: divisionId,
      display_name: who,
      contact_email: `${who.toLowerCase().replace(/\W+/g, "-")}-${randomBytes(3).toString("hex")}@example.com`,
      privacy_consent: true,
    },
  );
}

async function grantPass(compId: string, orgId: string, intent?: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into competition_passes (competition_id, org_id, stripe_payment_intent)
      values (${compId}, ${orgId}, ${intent ?? null})
      on conflict (competition_id) do nothing`;
  });
}

/** A paid sponsor package order with an ACTIVE placement, matched by intent. */
async function seedSponsorRig(
  orgId: string,
  compId: string | null,
  intent: string,
): Promise<{ sponsorId: string; orderId: string; sponsorName: string }> {
  const tag = randomBytes(5).toString("hex");
  const sponsorName = `PH Sponsor ${tag}`;
  return withDb(async (sql) => {
    const [{ id: sponsorId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status, display_order)
      values (${orgId}, ${compId}, ${sponsorName}, 'gold', 'active', 0)
      returning id`;
    const [{ id: packageId }] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${compId}, ${"Gold " + tag}, 25000, 'gbp', 'gold')
      returning id`;
    const [{ id: orderId }] = await sql<{ id: string }[]>`
      insert into sponsor_orders
        (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency,
         status, paid_at, payment_intent_id, sponsor_id)
      values (${orgId}, ${packageId}, ${sponsorName}, ${`s-${tag}@x.test`}, 25000, 'gbp',
              'paid', now(), ${intent}, ${sponsorId})
      returning id`;
    return { sponsorId, orderId, sponsorName };
  });
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Log the current page's context in as a seeded org's own owner (keeps the
 *  Pro storageState localStorage → cookie-consent stays pre-dismissed). */
async function loginAsOwner(page: Page, email: string): Promise<void> {
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
}

/** The public competition page is ISR (revalidate=30) and sponsor writes bust
 *  it from a DEFERRED after()-hook, so a bare reload can race the invalidation.
 *  Poll-reload until the placement reaches the expected visibility. */
async function expectSponsorOnPage(
  page: Page,
  url: string,
  name: string,
  present: boolean,
): Promise<void> {
  await expect(async () => {
    await page.goto(url);
    if (present) await expect(page.getByText(name)).toBeVisible({ timeout: 2_000 });
    else await expect(page.getByText(name)).toHaveCount(0);
  }).toPass({ timeout: 40_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] });
}

// ===========================================================================
// Step 1 — the harness itself
// ===========================================================================

test.describe("Task 17 · signed-webhook harness", () => {
  test("a signed event round-trips 200; an unsigned one is 400", async ({ request }) => {
    // A well-formed but unhandled event still ACKs 200 (silent no-op dispatch).
    const ok = await postSignedEvent(request, stripeEvent("customer.created", { id: uid("cus") }));
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as { received?: boolean }).received).toBe(true);

    // No signature → the route rejects before dispatch (proves signing is live).
    const bad = await request.post("/api/webhooks/stripe", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify(stripeEvent("customer.created", {})),
    });
    expect(bad.status()).toBe(400);
  });
});

// ===========================================================================
// T1 — competition-delete money guards (P0-1)
// ===========================================================================

test.describe("T1 · competition delete is blocked while money is on file", () => {
  test("all three money guards 409 with their archive hint", async ({ page }) => {
    const org = await activeOrg(page); // the shared Pro org (unlimited comps)

    // (a) Event Pass.
    const passComp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `T1 pass ${TAG} ${randomBytes(3).toString("hex")}`,
      visibility: "private",
    });
    await grantPass(passComp.data!.id, org.id, uid("pi"));
    const passDel = await apiJson(page.request, `/api/v1/competitions/${passComp.data!.id}`, "DELETE");
    expect(passDel.status).toBe(409);
    expect(passDel.error?.message ?? "").toContain("Event Pass");

    // (b) Unrefunded card registration.
    const cardComp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `T1 card ${TAG} ${randomBytes(3).toString("hex")}`,
      visibility: "private",
    });
    const cardDiv = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/competitions/${cardComp.data!.id}/divisions`,
      "POST",
      { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG, eligibility: [] },
    );
    await withDb(async (sql) => {
      await sql`insert into registrations
        (division_id, org_id, status, display_name, contact_email, amount_cents,
         payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
        values (${cardDiv.data!.id}, ${org.id}, 'paid', 'P', ${`p-${TAG}@x.test`}, 2000,
                ${uid("pi")}, 0, false, '{}', '[]', ${uid("tok")})`;
    });
    const cardDel = await apiJson(page.request, `/api/v1/competitions/${cardComp.data!.id}`, "DELETE");
    expect(cardDel.status).toBe(409);
    expect(cardDel.error?.message ?? "").toContain("card payments");

    // (c) Paid sponsorship.
    const sponsorComp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `T1 sponsor ${TAG} ${randomBytes(3).toString("hex")}`,
      visibility: "private",
    });
    await seedSponsorRig(org.id, sponsorComp.data!.id, uid("pi"));
    const sponsorDel = await apiJson(
      page.request,
      `/api/v1/competitions/${sponsorComp.data!.id}`,
      "DELETE",
    );
    expect(sponsorDel.status).toBe(409);
    expect(sponsorDel.error?.message ?? "").toContain("sponsorship payment records");
  });
});

// ===========================================================================
// T2 — DELETE /competitions/:id is never key-accessible (NEVER_KEY_ROUTES)
// ===========================================================================

test.describe("T2 · API keys cannot delete a competition", () => {
  test("a live key is barred from DELETE /competitions/:id", async ({ page, playwright }) => {
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `T2 ${TAG} ${randomBytes(3).toString("hex")}`,
      visibility: "private",
    });
    // A read key only needs api.access (Pro); DELETE /competitions/:id is
    // structurally excluded (NEVER_KEY_ROUTES) so scope is irrelevant here.
    const key = await apiJson<{ secret: string }>(
      page.request,
      `/api/v1/orgs/${org.id}/api-keys`,
      "POST",
      { name: `t2 ${TAG}`, scopes: ["read"] },
    );
    expect(key.status).toBe(201);

    const keyApi = await playwright.request.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000",
      extraHTTPHeaders: { Authorization: `Bearer ${key.data!.secret}` },
    });
    try {
      const res = await keyApi.delete(`/api/v1/competitions/${comp.data!.id}`);
      expect(res.status()).toBe(403); // NEVER_KEY_ROUTES → "use a session login"
      // Session still can (proves the block is key-specific, not a broken route).
      const asOwner = await apiJson(page.request, `/api/v1/competitions/${comp.data!.id}`, "DELETE");
      expect(asOwner.status).toBeLessThan(300);
    } finally {
      await keyApi.dispose();
    }
  });
});

// ===========================================================================
// T3 — a fully-refunded Event Pass charge revokes the pass (P0-3a)
// ===========================================================================

test.describe("T3 · Event Pass refund revokes the pass", () => {
  test("charge.refunded revokes the pass — the entrant cap drops 64 → 32", async ({
    request,
  }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "community", chargesEnabled: true, connected: true });
    const { compId, compSlug } = await seedComp(org.orgId);
    // Uncapped by the organiser, so the PLAN quota is the only ceiling; sit the
    // division ON the community cap so entry 33 separates a passed comp from a
    // community one. (V310 killed the card-intake-closes proof — see the
    // COMMUNITY_ENTRANT_CAP note; the entrant cap is what the pass still grants.)
    const { divisionId } = await seedStripeDivision(compId, null);
    await grantPass(compId, org.orgId, intent);
    await fillDivision(divisionId, org.orgId, COMMUNITY_ENTRANT_CAP);

    // While the pass is held the cap is 64: entry 33 takes a real spot. A
    // passless community org would waitlist this, so the assertion is NOT vacuous.
    const held = await submitPublicRegistration(request, org.orgSlug, compSlug, divisionId, "Held 33");
    expect(held.status).toBe(201);
    expect(held.data!.status).toBe("pending");

    // A fully-refunded pass charge revokes the pass.
    const res = await postSignedEvent(
      request,
      stripeEvent("charge.refunded", {
        id: uid("ch"),
        payment_intent: intent,
        refunded: true,
        amount_refunded: 500,
      }),
    );
    expect(res.status()).toBe(200);

    // Pass row gone (DB) — the core revocation proof, unchanged.
    const passGone = await withDb((sql) =>
      sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`,
    );
    expect(passGone.length).toBe(0);

    // … and the cap has dropped back to 32: the next entry (the 34th spot-holder)
    // is over the community ceiling and waitlists. Reverting the revocation leaves
    // the cap at 64 and this comes back 'pending' — so the assertion can still fail.
    const afterRevoke = await submitPublicRegistration(
      request, org.orgSlug, compSlug, divisionId, "After Refund 34",
    );
    expect(afterRevoke.status).toBe(201);
    expect(afterRevoke.data!.status).toBe("waitlisted");
  });
});

// ===========================================================================
// T4 — a duplicate Event Pass payment auto-refunds (P0-3b)
// ===========================================================================

test.describe("T4 · duplicate Event Pass payment auto-refunds", () => {
  test("a second paid checkout leaves ONE pass and records the event", async ({ request }) => {
    const firstIntent = uid("pi");
    const dupIntent = uid("pi");
    const org = await seedOrg({ plan: "community" });
    const { compId } = await seedComp(org.orgId, "private");
    await grantPass(compId, org.orgId, firstIntent); // first payment already recorded

    // A second owner / tab pays for the already-passed comp.
    const event = stripeEvent("checkout.session.completed", {
      id: uid("cs"),
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: dupIntent,
      customer: uid("cus"),
      metadata: {
        org_id: org.orgId,
        competition_id: compId,
        pass_key: "event_pass",
      },
    });
    const res = await postSignedEvent(request, event);
    expect(res.status()).toBe(200);

    // Outcome: exactly ONE pass, intent unchanged — the second payment did NOT
    // create a row and did NOT overwrite the first intent.
    const passes = await withDb((sql) =>
      sql<{ stripe_payment_intent: string | null }[]>`
        select stripe_payment_intent from competition_passes where competition_id = ${compId}`,
    );
    expect(passes.length).toBe(1);
    expect(passes[0]!.stripe_payment_intent).toBe(firstIntent);

    // The event landed on the idempotency ledger, processed.
    const ledger = await withDb((sql) =>
      sql<{ processed_at: string | null }[]>`
        select processed_at from billing_events where id = ${(event as { id: string }).id}`,
    );
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.processed_at).not.toBeNull();

    // LIMITATION (reviewer IMPORTANT-2): competition_passes(competition_id) is
    // UNIQUE, so "one row + firstIntent" holds even if the dedup/auto-refund
    // branch were deleted. The dedup branch's ONLY side effect is
    // refundDuplicatePassPayment → getStripe().refunds.create, which is a
    // swallowed no-op under the dummy e2e key with NO DB row or analytics event
    // — so it is genuinely unobservable in a keyless/dummy-key e2e. The real
    // auto-refund contract is pinned by the unit test
    // apps/web/src/lib/__tests__/billing-pass-duplicate.test.ts (stubs the
    // Stripe seam and asserts refunds.create is called with the dup intent).
  });
});

// ===========================================================================
// T6 — sponsor package disputes (P0-2)
// ===========================================================================

test.describe("T6 · sponsor package disputes pull the placement", () => {
  test("created parks the placement off the public page", async ({ page, request }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "pro" });
    const { compId, compSlug } = await seedComp(org.orgId);
    const { sponsorName } = await seedSponsorRig(org.orgId, compId, intent);

    await page.goto(`/shared/${org.orgSlug}/${compSlug}`);
    await expect(page.getByText(sponsorName)).toBeVisible();

    const res = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.created", {
        id: uid("dp"),
        status: "needs_response",
        amount: 25000,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    expect(res.status()).toBe(200);

    await expectSponsorOnPage(page, `/shared/${org.orgSlug}/${compSlug}`, sponsorName, false);
  });

  test("closed lost writes off the order and keeps the placement pulled", async ({
    page,
    request,
  }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "pro" });
    const { compId, compSlug } = await seedComp(org.orgId);
    const { sponsorName, orderId } = await seedSponsorRig(org.orgId, compId, intent);
    const did = uid("dp");

    await postSignedEvent(
      request,
      stripeEvent("charge.dispute.created", {
        id: uid("dp"),
        status: "needs_response",
        amount: 25000,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    const lost = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.closed", {
        id: did,
        status: "lost",
        amount: 25000,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    expect(lost.status()).toBe(200);

    const [order] = await withDb((sql) =>
      sql<{ status: string }[]>`select status from sponsor_orders where id = ${orderId}`,
    );
    expect(order.status).toBe("refunded");

    await expectSponsorOnPage(page, `/shared/${org.orgSlug}/${compSlug}`, sponsorName, false);
  });

  test("closed won restores the placement", async ({ page, request }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "pro" });
    const { compId, compSlug } = await seedComp(org.orgId);
    const { sponsorName } = await seedSponsorRig(org.orgId, compId, intent);
    const did = uid("dp");

    await postSignedEvent(
      request,
      stripeEvent("charge.dispute.created", {
        id: uid("dp"),
        status: "needs_response",
        amount: 25000,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    // Parked → not on the page.
    await expectSponsorOnPage(page, `/shared/${org.orgSlug}/${compSlug}`, sponsorName, false);

    const won = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.closed", {
        id: did,
        status: "won",
        amount: 25000,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    expect(won.status()).toBe(200);

    await expectSponsorOnPage(page, `/shared/${org.orgSlug}/${compSlug}`, sponsorName, true);
  });
});

// ===========================================================================
// T7 — platform-charge disputes (P1-4, decisions §6.2)
// ===========================================================================

test.describe("T7 · platform disputes truth-up entitlements", () => {
  test("subscription: created flags + stays Pro, closed lost downgrades to Community", async ({
    page,
    request,
  }) => {
    const customer = uid("cus");
    const org = await seedOrg({
      plan: "pro",
      customerId: customer,
      subscriptionId: uid("sub"),
    });
    const did = uid("dp");

    // Charge is EXPANDED with the customer (keyless — no charge retrieve needed).
    const created = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.created", {
        id: did,
        status: "needs_response",
        amount: 1900,
        currency: "gbp",
        payment_intent: uid("pi"),
        charge: { customer },
      }),
    );
    expect(created.status()).toBe(200);

    // Flag set (DB) …
    const [flagged] = await withDb((sql) =>
      sql<{ disputed_at: string | null; dispute_id: string | null; plan_key: string }[]>`
        select disputed_at, dispute_id, plan_key from subscriptions
         where id = (select subscription_id from organizations where id = ${org.orgId})`,
    );
    expect(flagged.disputed_at).not.toBeNull();
    expect(flagged.dispute_id).toBe(did);
    expect(flagged.plan_key).toBe("pro");

    // … and the billing UI is still Pro.
    await loginAsOwner(page, org.ownerEmail);
    await page.goto(`/o/${org.orgSlug}/settings/billing`);
    await expect(
      page.locator('[data-tour="billing-plan"]').getByText("Pro", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // The dispute is lost → auto-downgrade to Community.
    const lost = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.closed", {
        id: did,
        status: "lost",
        amount: 1900,
        currency: "gbp",
        payment_intent: uid("pi"),
        charge: { customer },
      }),
    );
    expect(lost.status()).toBe(200);

    await page.reload();
    await expect(
      page.locator('[data-tour="billing-plan"]').getByText("Community", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("Event Pass: a lost dispute revokes the pass — the entrant cap drops 64 → 32", async ({
    request,
  }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "community", chargesEnabled: true, connected: true });
    const { compId, compSlug } = await seedComp(org.orgId);
    // Same entrant-cap proof as T3 (card intake no longer closes on pass loss).
    const { divisionId } = await seedStripeDivision(compId, null);
    await grantPass(compId, org.orgId, intent);
    await fillDivision(divisionId, org.orgId, COMMUNITY_ENTRANT_CAP);

    // Pass held → cap 64 → entry 33 holds a spot (a passless community waitlists).
    const held = await submitPublicRegistration(request, org.orgSlug, compSlug, divisionId, "Held 33");
    expect(held.status).toBe(201);
    expect(held.data!.status).toBe("pending");

    const lost = await postSignedEvent(
      request,
      stripeEvent("charge.dispute.closed", {
        id: uid("dp"),
        status: "lost",
        amount: 2900,
        currency: "gbp",
        payment_intent: intent,
        charge: uid("ch"),
      }),
    );
    expect(lost.status()).toBe(200);

    // Pass row gone (DB) — the core revocation proof, unchanged.
    const passGone = await withDb((sql) =>
      sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`,
    );
    expect(passGone.length).toBe(0);

    // Cap back to 32 → the 34th spot-holder waitlists. Reverting the dispute
    // revocation leaves it 64 and this reads 'pending', so it can still fail.
    const afterRevoke = await submitPublicRegistration(
      request, org.orgSlug, compSlug, divisionId, "After Dispute 34",
    );
    expect(afterRevoke.status).toBe(201);
    expect(afterRevoke.data!.status).toBe("waitlisted");
  });
});

// ===========================================================================
// Replay idempotency — re-POST the SAME event id (global wave contract)
// ===========================================================================

test.describe("Replay · re-posting a processed event is a clean no-op", () => {
  test("a replayed charge.dispute.created ACKs 200 with no double effect", async ({ request }) => {
    const intent = uid("pi");
    const org = await seedOrg({ plan: "pro" });
    const { compId } = await seedComp(org.orgId);
    const { orderId } = await seedSponsorRig(org.orgId, compId, intent);

    // ONE event object with ONE id, reused verbatim on the replay — this is the
    // wave's idempotency contract (Stripe re-delivers the SAME event id).
    const event = stripeEvent("charge.dispute.created", {
      id: uid("dp"),
      status: "needs_response",
      amount: 25000,
      currency: "gbp",
      payment_intent: intent,
      charge: uid("ch"),
    });

    const first = await postSignedEvent(request, event);
    expect(first.status()).toBe(200);
    const [afterFirst] = await withDb((sql) =>
      sql<{ disputed_at: string | null; status: string }[]>`
        select o.disputed_at::text as disputed_at, s.status
        from sponsor_orders o join sponsors s on s.id = o.sponsor_id
        where o.id = ${orderId}`,
    );
    expect(afterFirst.disputed_at).not.toBeNull(); // flagged
    expect(afterFirst.status).toBe("pending"); // placement parked

    // Replay the IDENTICAL event id.
    const replay = await postSignedEvent(request, event);
    expect(replay.status()).toBe(200);
    expect(((await replay.json()) as { received?: boolean }).received).toBe(true);

    // Idempotency ledger holds exactly ONE row, and because the route's
    // already-processed fast path skips re-dispatch, the flag time is NOT
    // re-stamped and the placement is NOT re-mutated.
    const ledger = await withDb((sql) =>
      sql<{ id: string }[]>`select id from billing_events where id = ${(event as { id: string }).id}`,
    );
    expect(ledger.length).toBe(1);
    const [afterReplay] = await withDb((sql) =>
      sql<{ disputed_at: string | null; status: string }[]>`
        select o.disputed_at::text as disputed_at, s.status
        from sponsor_orders o join sponsors s on s.id = o.sponsor_id
        where o.id = ${orderId}`,
    );
    expect(afterReplay.disputed_at).toBe(afterFirst.disputed_at); // not re-stamped
    expect(afterReplay.status).toBe("pending"); // not re-mutated
  });
});

// ===========================================================================
// T8 — subscription-sync correctness (P1-5): stale delete guard
// ===========================================================================

test.describe("T8 · a stale subscription.deleted never downgrades a re-bought org", () => {
  test("deleted for an OLD sub id leaves the current sub Pro", async ({ request }) => {
    const org = await seedOrg({ plan: "pro", subscriptionId: uid("sub_new") });
    const staleSubId = uid("sub_old");

    const res = await postSignedEvent(
      request,
      stripeEvent("customer.subscription.deleted", {
        id: staleSubId,
        object: "subscription",
        metadata: { org_id: org.orgId },
      }),
    );
    expect(res.status()).toBe(200);

    const [sub] = await withDb((sql) =>
      sql<{ plan_key: string; status: string }[]>`
        select plan_key, status from subscriptions
         where id = (select subscription_id from organizations where id = ${org.orgId})`,
    );
    expect(sub.plan_key).toBe("pro"); // the replaced sub's late delete is ignored
    expect(sub.status).toBe("active");
  });
});

// ===========================================================================
// T9 — past_due grace (>14d) degrades to community at read time (P1-6)
// ===========================================================================

test.describe("T9 · past-due grace degrades to community after 14 days", () => {
  test("banner shows and Pro-gated actions 402 for a >14d past_due org", async ({ page }) => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString();
    const org = await seedOrg({ plan: "pro", subStatus: "past_due", subUpdatedAt: stale });

    await loginAsOwner(page, org.ownerEmail);

    // The past-due banner is visible (grace copy).
    await page.goto("/dashboard");
    await expect(
      page.getByText(/payment failed — your subscription is past due/i),
    ).toBeVisible({ timeout: 20_000 });

    // The entitlement resolves as community despite plan_key='pro' → a Pro-only
    // action (mint an API key needs api.access) 402s.
    const keyAttempt = await apiJson(page.request, `/api/v1/orgs/${org.orgId}/api-keys`, "POST", {
      name: `t9 ${TAG}`,
      scopes: ["read"],
    });
    expect(keyAttempt.status).toBe(402);
  });

  // Plan-generic (reviewer ITEM-3): the grace degrade applies to pro_plus too,
  // exercised end-to-end so the constraint is proven on the top paid tier.
  test("banner shows and gated writes 402 for a >14d past_due PRO PLUS org", async ({ page }) => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString();
    const org = await seedOrg({ plan: "pro_plus", subStatus: "past_due", subUpdatedAt: stale });

    await loginAsOwner(page, org.ownerEmail);

    await page.goto("/dashboard");
    await expect(
      page.getByText(/payment failed — your subscription is past due/i),
    ).toBeVisible({ timeout: 20_000 });

    // pro_plus degrades to community at read time → the api.access-gated write 402s.
    const keyAttempt = await apiJson(page.request, `/api/v1/orgs/${org.orgId}/api-keys`, "POST", {
      name: `t9plus ${TAG}`,
      scopes: ["read"],
    });
    expect(keyAttempt.status).toBe(402);
  });
});

// ===========================================================================
// T10 — a downgraded org closes card intake; a pass keeps that comp open (P2-10)
// ===========================================================================

test.describe("T10 · a pass lifts the entrant cap on its own comp only", () => {
  test("Community org: entry 33 waitlists on the no-pass comp, holds a spot on the passed comp", async ({
    page,
  }) => {
    // Connect stays LIVE; only the paid entitlement lapsed (community plan). V310
    // made registration.paid true on every plan, so card intake no longer closes
    // on plan loss — the entrant cap (community 32, pass 64) is the grant the pass
    // still uniquely provides, and it is competition-scoped.
    const org = await seedOrg({ plan: "community", chargesEnabled: true, connected: true });

    const plain = await seedComp(org.orgId);
    const plainDiv = await seedStripeDivision(plain.compId, null);

    const passed = await seedComp(org.orgId);
    const passedDiv = await seedStripeDivision(passed.compId, null);
    await grantPass(passed.compId, org.orgId);

    // Both sit exactly ON the community cap; entry 33 is the question.
    await fillDivision(plainDiv.divisionId, org.orgId, COMMUNITY_ENTRANT_CAP);
    await fillDivision(passedDiv.divisionId, org.orgId, COMMUNITY_ENTRANT_CAP);

    // Both card divisions render OPEN now (registration.paid holds on community),
    // so the register page alone proves nothing — the cap is what separates them.
    await page.goto(`/shared/${org.orgSlug}/${passed.compSlug}/register`);
    await expect(page.getByRole("radio").first()).toBeEnabled();

    const onPlain = await submitPublicRegistration(
      page.request, org.orgSlug, plain.compSlug, plainDiv.divisionId, "Plain 33",
    );
    const onPassed = await submitPublicRegistration(
      page.request, org.orgSlug, passed.compSlug, passedDiv.divisionId, "Passed 33",
    );

    // The pass lifts entrants.per_division.max 32 → 64 for ITS comp: entry 33 holds.
    expect(onPassed.status).toBe(201);
    expect(onPassed.data!.status).toBe("pending");
    // …and only its comp — the sibling still waitlists at 32. This is also the
    // org-wide-leak guard: a raised cap must not spill to the no-pass comp.
    // (Drop the pass and BOTH waitlist; leak it org-wide and BOTH pass — either
    // way an arm flips, so neither assertion is vacuous.)
    expect(onPlain.status).toBe(201);
    expect(onPlain.data!.status).toBe("waitlisted");
  });
});

// ===========================================================================
// T12 — Connect health banner (P1-8, V291 columns)
// ===========================================================================

test.describe("T12 · Connect health banner surfaces payout trouble", () => {
  test("banner absent when healthy, present when payouts lapse", async ({ page }) => {
    const org = await seedOrg({
      plan: "pro",
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: 0,
    });
    await loginAsOwner(page, org.ownerEmail);

    // Healthy: connected + payouts on + nothing due → no attention banner.
    await page.goto(`/o/${org.orgSlug}/settings/connect`);
    await page.waitForResponse(
      (r) => r.url().includes(`/orgs/${org.orgId}/connect`) && r.status() === 200,
    );
    await expect(page.getByTestId("connect-attention")).toHaveCount(0);
    // Healthy + live: dashboard link available, no verification CTA.
    await expect(page.getByTestId("connect-dashboard")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Finish Stripe verification" }),
    ).toHaveCount(0);

    // Payouts lapse (verification requirement) → the health mirror lights up.
    await withDb((sql) =>
      sql`update organizations set stripe_payouts_enabled = false, stripe_requirements_due = 2
          where id = ${org.orgId}`,
    );
    await page.reload();
    await page.waitForResponse(
      (r) => r.url().includes(`/orgs/${org.orgId}/connect`) && r.status() === 200,
    );
    await expect(page.getByTestId("connect-attention")).toBeVisible({ timeout: 20_000 });
    // A LIVE account with requirements due gets a way back into Stripe:
    // finish-verification (account_onboarding collects currently_due) and the
    // Express dashboard link stay side by side.
    await expect(
      page.getByRole("button", { name: "Finish Stripe verification" }),
    ).toBeVisible();
    await expect(page.getByTestId("connect-dashboard")).toBeVisible();

    // Dashboard mint fails here (dummy Stripe key, fake acct id) — the org
    // must see human copy, never Stripe's raw error (which carries the
    // platform key prefix and account id).
    await page.getByTestId("connect-dashboard").click();
    await expect(page.getByText("Couldn’t open the Stripe dashboard")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/rk_test|sk_test|provided key|acct_/)).toHaveCount(0);
  });
});

// ===========================================================================
// T15 — Pro AI generation cap (20 per division; V302, supersedes V291's 5)
// ===========================================================================

test.describe("T15 · Pro AI scheduling is capped per division", () => {
  test("the 21st generation on a division 402s with the cap key", async ({ page }) => {
    const org = await activeOrg(page); // shared Pro org (scheduling.ai + cap=20)
    const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `T15 ${TAG} ${randomBytes(3).toString("hex")}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG, eligibility: [] },
    );

    // Seed the 20 prior AI runs the cap counts from the audit ledger.
    await withDb(async (sql) => {
      for (let i = 0; i < 20; i++) {
        await sql`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${comp.data!.id}, ${org.id}, 'schedule.ai_generated',
                  ${sql.json({ division_id: div.data!.id })}, null)`;
      }
    });

    // The 21st generation is refused BEFORE the LLM with the per-division cap key.
    const res = await page.request.post(
      `/api/v1/divisions/${div.data!.id}/schedule/ai-plan`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ instruction: "no back-to-back games for anyone" }),
      },
    );
    expect(res.status()).toBe(402);
    const body = (await res.json()) as { error?: { feature_key?: string } };
    expect(body.error?.feature_key).toBe("scheduling.ai.runs_per_division.max");
  });
});

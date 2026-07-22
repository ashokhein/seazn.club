import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { TAG, apiJson, mintLoginPathBySql } from "./helpers";

// Event Pass, end to end, through a REAL Stripe test-mode purchase (task 22).
//
// Every other pass test in this repo grants the pass with an INSERT. This file
// is the one place where $29 actually moves: embedded checkout, card 4242,
// reconcile-on-return, and the invoice Stripe draws for it. Everything it then
// asserts — the lifted quota, the ceiling, the receipt, the Pro credit, the
// survival of a downgrade, the revocation on refund — hangs off that one real
// payment intent, so a break anywhere in the money trail surfaces here rather
// than being papered over by a seeded row.
//
// Use cases (spec 2026-07-21 "Use cases"), run at BOTH viewports:
//   U1  buy from a bitten gate; checkout, pass active, gate gone, invoice exists
//   U6  division 11 → Pro-only ceiling, pass credited, never re-sold
//   U7  public registration past the community cap on the passed competition
//   U12 billing page names the purchase and links its Stripe invoice
//   U14 upgrade to Pro inside 30 days: same customer, $29 on the balance,
//       card required, pass dormant not consumed
//   U15 Pro downgrades to community — the pass survives on its competition
//   U16 a full refund revokes the pass (and is where `refunds.create` on the
//       restricted test key gets exercised for the first time)
//
// ── Running it ──────────────────────────────────────────────────────────────
// A production server on PLAYWRIGHT_BASE against the same DATABASE_URL, and the
// REAL Stripe test keys in the spec's own environment (Playwright does not read
// .env.local — the server does):
//
//   cd apps/web && npm run build && npx next start -p 3021
//   set -a; . ./.env.local; set +a
//   E2E_PROD_TARGET=1 PLAYWRIGHT_BASE=http://localhost:3021 \
//     npx playwright test --project=parallel e2e/event-pass.spec.ts
//
// Nothing here skips. A missing key FAILS the run with the line above, because
// a green suite that quietly stopped buying anything is exactly the failure this
// file exists to prevent (task 22 step 3).
//
// ── Traps this file is shaped around ────────────────────────────────────────
// * COMPETITION SLUGS ARE UNIQUE PER ORG, NOT GLOBALLY. Every lookup, update
//   and delete below is scoped by `org_id`. An unscoped `where slug = $1`
//   already mutated a stranger's competition once on this branch, and the local
//   dev database holds ~68k organisations.
// * The checkout sheet caps at 85vh and Stripe sizes its iframe to its own
//   content, so "Pay" is frequently BELOW the sheet's clip. Playwright cannot
//   scroll a parent it does not own from inside a cross-origin frame — the sheet
//   is scrolled explicitly in `payWithTestCard`. Without it the click silently
//   lands on the overlay and the run hangs on the return URL.
// * Each block seeds its OWN org with its OWN owner (never the shared Pro or
//   community storageState accounts), so the shared org budget, the community
//   org's competition quota and pricing-v3/journey-community are all untouched.
// * No REDIS in e2e → `lib/cache` is inert, so SQL flips resolve fresh without
//   an entitlement-cache bust (same note as payments-hardening.spec.ts).

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const stripe = new Stripe(STRIPE_KEY || "sk_test_missing");

const GENERIC = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

/** Community's `entrants.per_division.max` (V311). The pass lifts it to 64, so
 *  entry 33 is the boundary that separates them — 17–32, which the spec's U7
 *  still names, is allowed on BOTH since V311 and proves nothing. */
const COMMUNITY_ENTRANT_CAP = 32;

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

interface Rig {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
  compId: string;
  compSlug: string;
}

/** A community org with its own owner and one unlisted competition.
 *
 *  Unlisted, not public: public registration accepts both, and community holds
 *  only ONE public competition (`dashboard.public.max` = 1) while U7 needs two
 *  side by side. */
async function seedRig(label: string): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `ep-${label}-${tag}@example.com`;
  const orgSlug = `ep-${label}-org-${tag}`;
  const compSlug = `ep-${label}-cup-${tag}`;
  return withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"EP Owner " + tag}, true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"EP Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    // A raw org insert leaves NO subscriptions row; the resolver's pass arm only
    // fires while the resolved plan is 'community', so pin it explicitly.
    await sql`insert into subscriptions (org_id, plan_key, status)
              values (${orgId}, 'community', 'active')`;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
      on conflict do nothing`;
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, branding)
      values (${orgId}, ${"EP Cup " + tag}, ${compSlug}, 'unlisted', ${sql.json({})})
      returning id`;
    return { orgId, orgSlug, ownerEmail, compId, compSlug };
  });
}

/** A second competition in the SAME org — U7's control arm. Scoped by org_id on
 *  the way in; the returned id is what every later lookup uses. */
async function seedSiblingCompetition(orgId: string, label: string): Promise<{ id: string; slug: string }> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const slug = `ep-${label}-plain-${tag}`;
  return withDb(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, branding)
      values (${orgId}, ${"EP Plain " + tag}, ${slug}, 'unlisted', ${sql.json({})})
      returning id`;
    return { id: row!.id, slug };
  });
}

/** Fill a division to `taken` spot-holding entries. Inserted directly: 32 round
 *  trips through the public endpoint would trip its own per-IP rate limit long
 *  before they finished. Scoped to a division this spec created. */
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

async function passRows(orgId: string): Promise<{ competition_id: string; stripe_payment_intent: string | null }[]> {
  return withDb((sql) => sql`
    select competition_id, stripe_payment_intent
    from competition_passes where org_id = ${orgId}`);
}

async function stripeCustomerId(orgId: string): Promise<string | null> {
  return withDb(async (sql) => {
    const [row] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where org_id = ${orgId}`;
    return row?.stripe_customer_id ?? null;
  });
}

/** Force a plan directly — the same SQL-flip convention helpers.ts uses, but
 *  keyed on an org THIS spec created, never a shared account. */
async function setPlan(orgId: string, planKey: string): Promise<void> {
  await withDb((sql) => sql`
    update subscriptions set plan_key = ${planKey}, status = 'active' where org_id = ${orgId}`);
}

/** Sign in as a seeded owner. Mints the login token in the DB rather than
 *  posting to /api/auth/magic-link: that route is rate-limited 5 per 5 min per
 *  IP and this file signs in twelve times a run. The context keeps the cookie-
 *  consent localStorage from storageState, so no banner intercepts anything. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(await mintLoginPathBySql(email));
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/magic-link") && !u.pathname.startsWith("/login"),
    { timeout: 30_000 },
  );
}

const upgradeUrl = (rig: Rig, query = "") => `/o/${rig.orgSlug}/c/${rig.compSlug}/upgrade${query}`;

/**
 * Probe whether the SERVER's Stripe key can actually mint a pass checkout, so
 * this money path skips cleanly on CI (dummy `sk_test_ci_e2e_dummy`) while a
 * real key still RUNS it — the same probe-and-skip billing.spec.ts uses.
 *
 * CI's dummy key 5xxes: `getStripe().checkout.sessions.create` throws (or the
 * event_pass price isn't synced → 503). A real key returns 200 with a
 * client_secret. The `beforeAll` still HARD-FAILS a genuinely missing/garbage
 * key (a developer who forgot `set -a; . ./.env.local` must see a failure, not a
 * quiet green) — this only skips a *functional* probe that reports Stripe
 * unusable. The pass-checkout idempotency key is org+comp+user scoped, so the
 * session this mints is the SAME one `[data-pass-buy]` later reuses: no double
 * session, no interference with U1's "exactly one pass, one intent" assertion.
 *
 * `request` must carry the signed-in owner's session (a `page.request`): the
 * endpoint reads the active-org cookie (getActiveOrgId), so set it first.
 */
async function passCheckoutProbeStatus(
  request: APIRequestContext,
  orgId: string,
  competitionId: string,
): Promise<number> {
  await apiJson(request, "/api/orgs/active", "POST", { org_id: orgId });
  const probe = await apiJson(request, "/api/billing/pass-checkout", "POST", {
    competition_id: competitionId,
  });
  return probe.status;
}

/**
 * The real purchase. Fills Stripe's embedded checkout with the 4242 test card
 * and waits for the app's own return URL.
 *
 * The country is pinned to GB rather than left to Stripe's IP guess: US swaps
 * the simple postal field for an address autocomplete with a different DOM, so
 * an unpinned run would be flaky by geography alone.
 */
async function fillCardFields(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe[src*="stripe.com"]').first();
  const card = frame.getByPlaceholder("1234 1234 1234 1234");
  await card.waitFor({ timeout: 60_000 });
  // Stripe mounts an Express Checkout element (Onelink / Apple Pay) alongside
  // the card form and re-renders the sheet as it settles. Typing into a form
  // that is still being rebuilt is the failure mode described below, so wait
  // for the express button first and fall through if the account never offers
  // one — this is a settle, not a requirement.
  await frame
    .getByRole("button", { name: /pay securely with/i })
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  await card.fill("4242424242424242");
  await frame.getByPlaceholder("MM / YY").fill("12 / 34");
  await frame.getByRole("textbox", { name: "CVC" }).fill("123");
  await frame.getByPlaceholder("Full name on card").fill("E2E Buyer");
  await frame.getByRole("combobox", { name: "Country or region" }).selectOption("GB");
  // Choosing a country REMOUNTS the address block, and typing into it before it
  // settles is silently destructive: the text lands in the DOM (the field reads
  // back "SW1A 1AA") while Stripe's own state stays empty, so pressing Pay puts
  // the button into "Processing" for ever and never calls /v1/payment_methods.
  // Verified both ways against this build — with the settle it pays in ~5s,
  // without it the run dies on the 150 s return-URL wait with no PaymentIntent
  // ever created. Re-queried after the wait so the locator resolves the NEW node.
  await page.waitForTimeout(1500);
  await frame.getByRole("textbox", { name: "Postal code" }).fill("SW1A 1AA");
  await page.waitForTimeout(500);
}

/** Bring the end of the checkout sheet — where "Pay" lives — into view. See the
 *  header: the sheet is the only scroller, and Playwright cannot reach it from
 *  inside the cross-origin frame. */
async function scrollSheetToEnd(page: Page): Promise<void> {
  await page
    .getByRole("dialog")
    .locator("div.overflow-y-auto")
    .first()
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await page.waitForTimeout(400);
}

/**
 * Open the checkout on the upgrade page and buy the pass with 4242.
 *
 * Retried, and the retry is deliberate rather than lazy. When Stripe's sheet
 * loses the race described in `fillCardFields`, pressing Pay spins for ever and
 * `/v1/payment_methods` is never called — verified in the traces of two failed
 * runs — so NOTHING reaches Stripe: no PaymentMethod, no PaymentIntent, no
 * charge. Re-opening from a fresh page load therefore cannot double-charge, and
 * the route's idempotency key (`pass-checkout-{org}-{comp}-{user}`) hands back
 * the SAME checkout session rather than minting a second one. U1 additionally
 * asserts that exactly one pass row and one intent exist afterwards, which is
 * what would catch a retry that did charge twice.
 *
 * Three consecutive hangs still fail the test. The wait is short on purpose: a
 * genuine card decline surfaces in seconds, so a long single wait would only
 * turn a fast red into a slow one.
 */
async function buyPassWithTestCard(page: Page, url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url);
    await page.locator("[data-pass-buy]").click();
    await expect(page.locator('iframe[src*="stripe.com"]').first()).toBeVisible({
      timeout: 45_000,
    });
    await fillCardFields(page);
    await scrollSheetToEnd(page);
    await page
      .frameLocator('iframe[src*="stripe.com"]')
      .first()
      .getByRole("button", { name: "Pay" })
      .click();
    try {
      await page.waitForURL(/upgrade\?checkout=success/, { timeout: 60_000 });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------

test.beforeAll(() => {
  // A failure, never a skip. See the header.
  if (!/^(sk|rk)_test_/.test(STRIPE_KEY)) {
    throw new Error(
      "event-pass.spec.ts needs a Stripe TEST key in STRIPE_SECRET_KEY " +
        "(`set -a; . ./.env.local; set +a`). It buys a real $29 test-mode pass.",
    );
  }
  if (!WEBHOOK_SECRET) {
    throw new Error(
      "event-pass.spec.ts needs STRIPE_WEBHOOK_SECRET — the same value the server " +
        "under test booted with — to sign the charge.refunded event for U16.",
    );
  }
});

const VIEWPORTS = [
  { label: "d", name: "desktop", viewport: { width: 1280, height: 720 } },
  { label: "m", name: "mobile", viewport: { width: 390, height: 844 } },
] as const;

for (const vp of VIEWPORTS) {
  test.describe.serial(`Event Pass money path — ${vp.name}`, () => {
    test.use({ viewport: vp.viewport });

    let rig: Rig;
    let divisionIds: string[] = [];
    let passIntent = "";
    // Set true by U1's probe only when the server's Stripe is usable; the rest
    // of the serial money path gates on it so CI (dummy key) skips cleanly.
    let stripeUsable = false;

    test(`U1 · buys the pass from the gate that bit, and the gate lifts (${vp.name})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      rig = await seedRig(vp.label);
      divisionIds = [];
      await signIn(page, rig.ownerEmail);

      // Gate the whole money path on the server's Stripe being usable (see
      // passCheckoutProbeStatus): CI's dummy key 5xxes and the suite skips; a
      // real key returns 200 and everything below RUNS for real.
      const probeStatus = await passCheckoutProbeStatus(page.request, rig.orgId, rig.compId);
      stripeUsable = probeStatus === 200;
      test.skip(probeStatus >= 500, "Stripe not usable (dummy key) — skipping the pass money path");
      // Pin the non-skip path to a real 200 so this can never silently become an
      // unconditional skip (billing.spec.ts:255-257 learned this the hard way).
      expect(probeStatus).toBe(200);

      // Community's `divisions.per_competition.max` is 2 — fill it, then bite.
      for (const name of ["One", "Two"]) {
        const d = await apiJson<{ id: string }>(
          page.request,
          `/api/v1/competitions/${rig.compId}/divisions`,
          "POST",
          { name, ...GENERIC },
        );
        expect(d.status).toBe(201);
        divisionIds.push(d.data!.id);
      }
      const bitten = await apiJson(
        page.request,
        `/api/v1/competitions/${rig.compId}/divisions`,
        "POST",
        { name: "Three", ...GENERIC },
      );
      expect(bitten.status).toBe(402);

      // The gate where the limit bites offers the per-event path for THIS
      // competition — the entry point U1 names.
      await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/new`);
      await page.getByPlaceholder("U16 Boys T20").fill("Gate Trigger");
      await page.getByRole("button", { name: "Scheduling" }).click();
      await page.getByRole("button", { name: "Create division" }).click();
      // Scoped to the feature that bit — this page carries other gates.
      const gate = page.locator('[data-pass-gate][data-feature="divisions.per_competition.max"]');
      await expect(gate).toBeVisible({ timeout: 30_000 });
      await expect(gate.locator("[data-pass-cta]")).toContainText("$29");
      const passHref = await gate.locator("[data-pass-cta]").getAttribute("href");
      // The gate appends `?feature=<key>` so the upgrade page can render its
      // ceiling state (76020eeb) — anchor on the path, not the whole string, and
      // assert the key rides along rather than relaxing to a bare prefix.
      expect(passHref).toMatch(new RegExp(`/c/${rig.compSlug}/upgrade(\\?|$)`));
      expect(passHref).toContain("feature=divisions.per_competition.max");

      // …and the ticket it leads to is the unsold one.
      await page.goto(passHref!);
      await expect(page.locator("[data-pass-ticket]")).toContainText("$29");
      await expect(page.locator("[data-pass-buy]")).toBeVisible();

      await buyPassWithTestCard(page, passHref!);

      // Reconcile-on-return records the pass without waiting for a webhook.
      const rows = await passRows(rig.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.competition_id).toBe(rig.compId);
      expect(rows[0]!.stripe_payment_intent).toMatch(/^pi_/);
      passIntent = rows[0]!.stripe_payment_intent!;

      // The page it lands on states the purchase and stops selling it. The
      // page-wide "$29" negative is the point: the worst failure this surface
      // can have is selling the same competition twice.
      await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-pass-cta]")).toHaveCount(0);
      expect(await page.locator("main").innerText()).not.toContain("$29");

      // Stripe drew a real invoice for it (U1's "invoice exists").
      const pi = await stripe.paymentIntents.retrieve(passIntent);
      expect(pi.status).toBe("succeeded");
      expect(pi.amount).toBe(2900);
      // `invoice_creation` draws the invoice AFTER the payment succeeds, so this
      // polls rather than reading once — a bare read here loses the race by a
      // second or two and reports "no invoice" for money that is on its way.
      await expect
        .poll(
          async () => {
            const invoices = await stripe.invoices.list({
              customer: pi.customer as string,
              limit: 5,
            });
            return invoices.data.some((i) => i.total === 2900 && !!i.hosted_invoice_url);
          },
          { timeout: 60_000, intervals: [1_000, 2_000, 3_000, 5_000] },
        )
        .toBe(true);

      // The gate is gone: the write that 402'd before now goes through.
      const third = await apiJson<{ id: string }>(
        page.request,
        `/api/v1/competitions/${rig.compId}/divisions`,
        "POST",
        { name: "Three", ...GENERIC },
      );
      expect(third.status).toBe(201);
      divisionIds.push(third.data!.id);
    });

    test(`U6 · division 11 hits a Pro-only ceiling and the pass is never re-sold (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      test.setTimeout(180_000);
      await signIn(page, rig.ownerEmail);

      // The pass grants 10. Fill 4..10, then ask for 11.
      for (let n = divisionIds.length + 1; n <= 10; n++) {
        const d = await apiJson<{ id: string }>(
          page.request,
          `/api/v1/competitions/${rig.compId}/divisions`,
          "POST",
          { name: `Div ${n}`, ...GENERIC },
        );
        expect(d.status, `division ${n} on a passed competition`).toBe(201);
        divisionIds.push(d.data!.id);
      }
      expect(divisionIds).toHaveLength(10);

      const eleventh = await apiJson(
        page.request,
        `/api/v1/competitions/${rig.compId}/divisions`,
        "POST",
        { name: "Div 11", ...GENERIC },
      );
      expect(eleventh.status).toBe(402);
      expect(eleventh.error?.code).toBe("PAYMENT_REQUIRED");

      // The paywall now renders pass-OWNED: one Pro path out, no second $29.
      await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/new`);
      await page.getByPlaceholder("U16 Boys T20").fill("Eleventh");
      await page.getByRole("button", { name: "Scheduling" }).click();
      await page.getByRole("button", { name: "Create division" }).click();
      // Scoped to the feature that actually bit. The scheduling tab carries its
      // own COMPACT gate (`scheduling.constraints`, a Pro key the pass never
      // covered) which also marks itself `data-pass-owned` once a pass is held,
      // so `.first()` reads the wrong card and asserts nothing about divisions.
      const owned = page.locator(
        '[data-pass-owned][data-feature="divisions.per_competition.max"]',
      );
      await expect(owned).toBeVisible({ timeout: 30_000 });
      await expect(owned).toContainText("Event Pass active");
      // Page-wide, and deliberately so: no gate anywhere on this page may offer
      // the pass a second time to an org that already holds it.
      await expect(page.locator("[data-pass-cta]")).toHaveCount(0);

      // The upgrade page's ceiling state names the limit that blocked them and
      // promises the credit — which is real here, because U1 actually paid.
      await page.goto(upgradeUrl(rig, "?feature=divisions.per_competition.max"));
      await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-ceiling-row]")).toHaveCount(1);
      await expect(page.locator("[data-ceiling-row]")).toContainText("Divisions");
      await expect(page.locator("[data-pass-credit]")).toBeVisible();
      expect(await page.locator("main").innerText()).not.toContain("$29");
    });

    test(`U7 · public registration passes 32 on the passed competition only (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      test.setTimeout(180_000);
      await signIn(page, rig.ownerEmail);

      const settings = {
        enabled: true,
        entrant_kind: "individual",
        // Unlimited by the organiser's own choice, so the PLAN quota is the only
        // thing that can waitlist anyone — otherwise this measures capacity.
        capacity: null,
        fee_cents: 0,
        currency: "gbp",
        form_fields: [],
        payment_method: "offline",
      };

      const passedDivision = divisionIds[0]!;
      expect(
        (await apiJson(
          page.request,
          `/api/v1/divisions/${passedDivision}/registration-settings`,
          "PUT",
          settings,
        )).status,
      ).toBeLessThan(300);

      const plain = await seedSiblingCompetition(rig.orgId, vp.label);
      const plainDiv = await apiJson<{ id: string }>(
        page.request,
        `/api/v1/competitions/${plain.id}/divisions`,
        "POST",
        { name: "Open", ...GENERIC },
      );
      expect(plainDiv.status).toBe(201);
      expect(
        (await apiJson(
          page.request,
          `/api/v1/divisions/${plainDiv.data!.id}/registration-settings`,
          "PUT",
          settings,
        )).status,
      ).toBeLessThan(300);

      // Both sit exactly ON the community cap, so entry 33 is the question.
      await fillDivision(passedDivision, rig.orgId, COMMUNITY_ENTRANT_CAP);
      await fillDivision(plainDiv.data!.id, rig.orgId, COMMUNITY_ENTRANT_CAP);

      const submit = (compSlug: string, divisionId: string, who: string) =>
        apiJson<{ status: string }>(
          page.request,
          `/api/v1/public/orgs/${rig.orgSlug}/competitions/${compSlug}/register`,
          "POST",
          {
            division_id: divisionId,
            display_name: who,
            contact_email: `${who.toLowerCase().replace(/\W+/g, "-")}-${randomBytes(3).toString("hex")}@example.com`,
            privacy_consent: true,
          },
        );

      const onPassed = await submit(rig.compSlug, passedDivision, "Entry Thirty Three");
      const onPlain = await submit(plain.slug, plainDiv.data!.id, "Plain Thirty Three");

      // The pass lifts `entrants.per_division.max` 32 → 64 for ITS competition.
      expect(onPassed.status).toBe(201);
      expect(onPassed.data!.status).toBe("pending");
      // …and only its competition. Without this arm the test would still pass
      // if the raised cap leaked org-wide, which is the other half of the bug.
      expect(onPlain.status).toBe(201);
      expect(onPlain.data!.status).toBe("waitlisted");
    });

    test(`U12 · the billing page names the purchase and links its invoice (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      await signIn(page, rig.ownerEmail);
      await page.goto(`/o/${rig.orgSlug}/settings/billing`);

      const purchases = page.locator("[data-pass-purchases]");
      await expect(purchases).toBeVisible({ timeout: 30_000 });
      // Named after the competition it bought, not an anonymous Stripe row —
      // the whole reason this section exists next to the invoice list.
      await expect(purchases).toContainText("EP Cup");
      // `formatMinor` drops the trailing zeros on a whole amount, so this is
      // "$29", not "$29.00". The figure itself is the assertion that matters:
      // the row renders an amount ONLY when the Stripe invoice read succeeded
      // (a staff grant, or a failed read, renders the date alone).
      await expect(purchases).toContainText("$29");
      const invoice = purchases.getByRole("link", { name: /invoice/i }).first();
      await expect(invoice).toHaveAttribute("href", /invoice\.stripe\.com/);
    });

    test(`U14 · upgrading to Pro credits the pass and leaves it dormant (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      test.setTimeout(120_000);
      await signIn(page, rig.ownerEmail);

      const checkout = await apiJson<{ client_secret?: string }>(
        page.request,
        "/api/billing/checkout",
        "POST",
        { plan_key: "pro", interval: "monthly" },
      );
      expect(checkout.status).toBe(200);
      expect(checkout.data?.client_secret).toBeTruthy();

      // Same Stripe customer the $29 was charged to — a second customer would
      // strand the credit where the subscription can never draw on it.
      const customerId = await stripeCustomerId(rig.orgId);
      const pi = await stripe.paymentIntents.retrieve(passIntent);
      expect(customerId).toBe(pi.customer);

      // $29 sits on the customer BALANCE (D12 — Checkout refuses `discounts`
      // alongside `allow_promotion_codes`, so a balance credit is the only lever).
      const customer = (await stripe.customers.retrieve(customerId!)) as Stripe.Customer;
      expect(customer.balance).toBe(-2900);
      const txns = await stripe.customers.listBalanceTransactions(customerId!, { limit: 5 });
      expect(
        txns.data.some((t) => t.metadata?.pass_payment_intent === passIntent),
        "the credit is traceable back to the pass that earned it",
      ).toBe(true);

      // A pass holder's trial must start with a card on file.
      const sessions = await stripe.checkout.sessions.list({ customer: customerId!, limit: 1 });
      expect(sessions.data[0]!.mode).toBe("subscription");
      expect(sessions.data[0]!.payment_method_collection).toBe("always");

      // Dormant, not consumed: the row survives the upgrade (U14 / U15).
      const rows = await passRows(rig.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stripe_payment_intent).toBe(passIntent);
    });

    test(`U15 · a Pro org that downgrades keeps the pass on its competition (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      test.setTimeout(120_000);
      await signIn(page, rig.ownerEmail);

      // On Pro the page must not price anything: Pro's matrix is a strict
      // superset of the pass, so an offer here would sell a downgrade.
      await setPlan(rig.orgId, "pro");
      await page.goto(upgradeUrl(rig));
      await expect(page.locator("[data-plan-covered]")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-pass-dormant]")).toBeVisible();
      await expect(page.locator("[data-pass-ticket]")).toHaveCount(0);
      expect(await page.locator("main").innerText()).not.toContain("$29");

      // Downgrade through the app (no live Stripe subscription on this org).
      await page.goto(`/o/${rig.orgSlug}/settings/billing`);
      await page.getByRole("button", { name: "Downgrade to Community" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Downgrade" }).click();
      await expect(
        page.locator('[data-tour="billing-plan"]').getByText("Community", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      // THE ASSERTION: the pass survives the plan it outlived.
      const rows = await passRows(rig.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stripe_payment_intent).toBe(passIntent);
      await page.goto(upgradeUrl(rig));
      await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });

      // …and still GRANTS: an 11th division is refused, a 10th-slot write is not.
      // (Divisions 3–10 exist only because the pass raised the cap from 2.)
      const overCap = await apiJson(
        page.request,
        `/api/v1/competitions/${rig.compId}/divisions`,
        "POST",
        { name: "Post-downgrade 11", ...GENERIC },
      );
      expect(overCap.status).toBe(402);
    });

    test(`U16 · a full refund revokes the pass and the offer comes back (${vp.name})`, async ({
      page,
    }) => {
      test.skip(!stripeUsable, "Stripe not usable — U1 skipped the pass money path");
      test.setTimeout(180_000);
      await signIn(page, rig.ownerEmail);

      // This is the first exercise of `refunds.create` on the restricted test
      // key. A permissions failure here is a real finding, not a flake — do NOT
      // wrap it in a try/catch to keep the suite green.
      const refund = await stripe.refunds.create(
        { payment_intent: passIntent },
        { idempotencyKey: `e2e-pass-refund-${passIntent}` },
      );
      expect(refund.status).toBe("succeeded");
      expect(refund.amount).toBe(2900);

      // Stripe would deliver charge.refunded to a public endpoint; localhost has
      // none, so the REAL charge object is posted to the real webhook route with
      // a real signature (same harness as payments-hardening.spec.ts).
      const pi = await stripe.paymentIntents.retrieve(passIntent, { expand: ["latest_charge"] });
      const charge = pi.latest_charge as Stripe.Charge;
      expect(charge.refunded).toBe(true);
      const event = {
        id: `evt_${randomBytes(8).toString("hex")}`,
        object: "event",
        api_version: "2024-06-20",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        request: { id: null, idempotency_key: null },
        type: "charge.refunded",
        data: { object: charge },
      };
      const payload = JSON.stringify(event);
      const res = await page.request.post("/api/webhooks/stripe", {
        headers: {
          "stripe-signature": stripe.webhooks.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          }),
          "content-type": "application/json",
        },
        data: payload,
      });
      expect(res.status()).toBeLessThan(300);

      // Money back means the competition rejoins the quota.
      expect(await passRows(rig.orgId)).toHaveLength(0);
      await page.goto(upgradeUrl(rig));
      await expect(page.locator("[data-pass-ticket]")).toContainText("$29");
      await expect(page.locator("[data-pass-buy]")).toBeVisible();
    });
  });
}

/**
 * The cookie-consent banner and every dialog overlay both sat at `z-50`, and the
 * banner is mounted last in the root layout — so on a phone it painted OVER the
 * checkout sheet and swallowed the click on "Pay". A first-time buyer (the only
 * kind who sees the banner) could not complete a purchase at all.
 *
 * Asserted as a hit test rather than a screenshot: `elementFromPoint` at the
 * button's own centre is exactly the question the browser asks when the buyer
 * clicks. Red before the fix at 390×844, where it resolved to the banner.
 *
 * Deliberately in a FRESH context: every other test here inherits storageState,
 * which pre-dismisses the banner and hides the defect completely.
 */
test.describe("checkout sheet vs the cookie banner", () => {
  for (const vp of VIEWPORTS) {
    test(`Pay is the top element for a buyer who has not answered the banner (${vp.name})`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const rig = await seedRig(`z${vp.label}`);
      // EMPTY storage state, spelled out. `browser.newContext()` alone inherits
      // the project's storageState, which carries the consent localStorage
      // auth.setup.ts writes — and with the banner pre-dismissed this test
      // passes trivially against the very defect it exists to catch.
      const ctx = await browser.newContext({
        viewport: vp.viewport,
        storageState: { cookies: [], origins: [] },
      });
      try {
        const page = await ctx.newPage();
        await signIn(page, rig.ownerEmail);
        // Same money-path gate as the serial block: this test opens the REAL
        // Stripe iframe, which never mounts under CI's dummy key. Skip cleanly
        // there; a real key returns 200 and the hit-test RUNS.
        const probeStatus = await passCheckoutProbeStatus(page.request, rig.orgId, rig.compId);
        test.skip(probeStatus >= 500, "Stripe not usable (dummy key) — skipping");
        expect(probeStatus).toBe(200);
        await page.goto(upgradeUrl(rig));
        // The banner must actually be up, or this proves nothing.
        await expect(page.getByRole("button", { name: "Reject" })).toBeVisible({ timeout: 20_000 });

        await page.locator("[data-pass-buy]").click();
        await expect(page.locator('iframe[src*="stripe.com"]').first()).toBeVisible({
          timeout: 45_000,
        });
        // Fill the card exactly as the money-path tests do, and for the same
        // reason: Stripe resizes its iframe as the form fills, and hit-testing a
        // sheet that is still growing measures the wrong geometry. This is also
        // the honest moment to ask the question — a buyer hit-tests "Pay" when
        // they have finished typing, not when the sheet opens. Nothing is
        // bought here; the button is measured, never pressed.
        await fillCardFields(page);
        await scrollSheetToEnd(page);

        const frame = page.frameLocator('iframe[src*="stripe.com"]').first();
        const pay = frame.getByRole("button", { name: "Pay" });
        const box = (await pay.boundingBox())!;
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x, y)?.tagName ?? "NONE",
          [box.x + box.width / 2, box.y + box.height / 2] as const,
        );
        expect(hit, "the consent banner must not cover the checkout sheet").toBe("IFRAME");
      } finally {
        await ctx.close();
      }
    });
  }
});

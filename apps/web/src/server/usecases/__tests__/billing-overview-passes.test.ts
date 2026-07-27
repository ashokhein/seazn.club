// Event Pass purchases on the billing page (v3/07 §3, Task 14). A $29 pass used
// to leave the buyer with a generic Stripe invoice row and no clue which
// competition it paid for; getPassPurchases names the competition.
//
// The shape under test is the point: `competition_passes` (V271) is five columns
// with NO amount and NO invoice id, so the rows come from the DATABASE and are
// only ENRICHED from Stripe by payment intent. That is why this is not part of
// BillingOverview — that whole shape is a live Stripe read that returns null for
// an org with no Stripe customer or an unreachable Stripe, which would hide a
// pass the org genuinely holds. Both of those cases are covered below.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is mocked (the
// suite never has a key), and `stripeMock.fail` reproduces the keyless /
// unreachable case where getStripe() itself throws. Seeds are run-unique
// (randomUUID) and torn down in afterAll.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({
  list: vi.fn(),
  /** true = getStripe() throws, exactly as it does with no STRIPE_SECRET_KEY. */
  fail: false,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    if (stripeMock.fail) throw new Error("STRIPE_SECRET_KEY is not set.");
    return { invoicePayments: { list: stripeMock.list } };
  },
}));

import { sql } from "@/lib/db";
import { getPassPurchases } from "../billing-manage";
import type { PassKey } from "@/lib/currency";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);
const orgIds: string[] = [];

async function seedOrg(): Promise<string> {
  const suffix = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pass Org " + suffix}, ${"pass-org-" + suffix}) returning id`;
  orgIds.push(id);
  return id;
}

async function seedComp(orgId: string, label: string): Promise<{ id: string; slug: string }> {
  const suffix = uniq();
  const slug = `${label}-${suffix}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${`${label} ${suffix}`}, ${slug}) returning id`;
  return { id, slug };
}

/** `passKey` is REQUIRED (v17 #294): the column is `not null default
 *  'event_pass'`, so an omitted rung is silently an M row — the same landmine
 *  `recordPassPurchase` carried, and the exact state a test asserting L would
 *  pass against for the wrong reason. */
async function grantPass(
  compId: string,
  orgId: string,
  intent: string | null,
  purchasedAt: string,
  passKey: PassKey,
): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at, pass_key)
    values (${compId}, ${orgId}, ${intent}, ${purchasedAt}, ${passKey})`;
}

/** SPEC-4 §9: set the competition's lifecycle so `ended` can be exercised. */
async function setCompLifecycle(
  compId: string,
  status: string,
  endsOn: string | null,
): Promise<void> {
  await sql`update competitions set status = ${status}, ends_on = ${endsOn} where id = ${compId}`;
}

/** One paid invoice for the intent, as invoicePayments.list returns it. */
function invoiceFor(total: number, currency = "gbp", url = "https://invoice.stripe.test/i/x") {
  return { data: [{ invoice: { total, currency, hosted_invoice_url: url } }] };
}

beforeEach(() => {
  stripeMock.list.mockReset();
  stripeMock.fail = false;
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`delete from competition_passes where org_id = any(${orgIds})`;
    await sql`delete from competitions where org_id = any(${orgIds})`;
    await sql`delete from organizations where id = any(${orgIds})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getPassPurchases", () => {
  it("returns one row per pass with the competition name and slug resolved", async () => {
    const orgId = await seedOrg();
    const spring = await seedComp(orgId, "spring-open");
    const autumn = await seedComp(orgId, "autumn-cup");
    await grantPass(spring.id, orgId, `pi_${uniq()}`, "2026-03-01T10:00:00Z", "event_pass");
    await grantPass(autumn.id, orgId, `pi_${uniq()}`, "2026-09-01T10:00:00Z", "event_pass");
    stripeMock.list.mockResolvedValue(invoiceFor(2900));

    const rows = await getPassPurchases(orgId);

    expect(rows).toHaveLength(2);
    // Newest first, and each row is NAMED — the whole point of the task.
    expect(rows[0].competitionSlug).toBe(autumn.slug);
    expect(rows[0].competitionName).toContain("autumn-cup");
    expect(rows[0].competitionId).toBe(autumn.id);
    expect(rows[0].purchasedIso).toBe("2026-09-01T10:00:00.000Z");
    expect(rows[1].competitionSlug).toBe(spring.slug);
    expect(rows[1].purchasedIso).toBe("2026-03-01T10:00:00.000Z");
  });

  it("carries the RUNG that was bought, on every row", async () => {
    // v17 #294. Without it the billing list renders a $29 M purchase and a $59
    // L purchase identically. `amountMinor` cannot stand in: it is null for a
    // staff grant and null again whenever the Stripe read fails — precisely
    // the rows where nothing else identifies the purchase.
    const orgId = await seedOrg();
    const small = await seedComp(orgId, "small-open");
    const big = await seedComp(orgId, "big-open");
    await grantPass(small.id, orgId, `pi_${uniq()}`, "2026-03-01T10:00:00Z", "event_pass");
    await grantPass(big.id, orgId, `pi_${uniq()}`, "2026-09-01T10:00:00Z", "event_pass_l");
    stripeMock.list.mockResolvedValue(invoiceFor(2900));

    const byId = Object.fromEntries(
      (await getPassPurchases(orgId)).map((r) => [r.competitionId, r.passKey]),
    );

    // Both arms: "L reads L" alone would pass against a reader hardcoded to L.
    expect(byId[big.id]).toBe("event_pass_l");
    expect(byId[small.id]).toBe("event_pass");
  });

  // Deliberately NOT tested from the database: `competition_passes.pass_key`
  // carries an FK to `plans` (V341's own RED was that violation), so a row with
  // an unrecognised rung cannot exist. The `isPassKey` guard in
  // `getPassPurchases` is defence against a build predating a rung someone
  // else's migration added, and the only way to exercise it would be to insert
  // a bogus `plans` row — a GLOBAL table other suites read from.

  it("takes the amount and the hosted invoice link from the pass's own invoice", async () => {
    const orgId = await seedOrg();
    const comp = await seedComp(orgId, "club-champs");
    const intent = `pi_${uniq()}`;
    await grantPass(comp.id, orgId, intent, "2026-05-05T09:00:00Z", "event_pass");
    stripeMock.list.mockResolvedValue(
      invoiceFor(2900, "gbp", "https://invoice.stripe.test/i/club-champs"),
    );

    const [row] = await getPassPurchases(orgId);

    // The payment intent is the ONLY correlation key the schema offers.
    expect(stripeMock.list).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: { type: "payment_intent", payment_intent: intent },
      }),
    );
    expect(row.amountMinor).toBe(2900);
    expect(row.currency).toBe("gbp");
    expect(row.hostedInvoiceUrl).toBe("https://invoice.stripe.test/i/club-champs");
  });

  it("keeps a pass with NO payment intent — staff-granted, and never charged", async () => {
    const orgId = await seedOrg();
    const comp = await seedComp(orgId, "comped-cup");
    await grantPass(comp.id, orgId, null, "2026-04-01T09:00:00Z", "event_pass");

    const [row] = await getPassPurchases(orgId);

    // Dropping it would hide a competition the org genuinely holds a pass for.
    expect(row.competitionSlug).toBe(comp.slug);
    expect(row.amountMinor).toBeNull();
    expect(row.currency).toBeNull();
    expect(row.hostedInvoiceUrl).toBeNull();
    // Nothing to correlate, so no Stripe call is issued for it at all.
    expect(stripeMock.list).not.toHaveBeenCalled();
  });

  it("still lists the pass when Stripe is unreachable — only the money columns go", async () => {
    const orgId = await seedOrg();
    const comp = await seedComp(orgId, "storm-shield");
    await grantPass(comp.id, orgId, `pi_${uniq()}`, "2026-06-01T09:00:00Z", "event_pass");
    stripeMock.list.mockRejectedValue(new Error("Stripe is down"));

    const [row] = await getPassPurchases(orgId);

    expect(row.competitionSlug).toBe(comp.slug);
    expect(row.competitionName).toContain("storm-shield");
    expect(row.amountMinor).toBeNull();
    expect(row.hostedInvoiceUrl).toBeNull();
  });

  it("still lists the pass for an org with no Stripe account at all", async () => {
    const orgId = await seedOrg();
    const comp = await seedComp(orgId, "keyless-cup");
    await grantPass(comp.id, orgId, `pi_${uniq()}`, "2026-07-01T09:00:00Z", "event_pass");
    // getStripe() throws before any request is made — the getBillingOverview
    // null case, which must not take the purchases list down with it.
    stripeMock.fail = true;

    const [row] = await getPassPurchases(orgId);

    expect(row.competitionSlug).toBe(comp.slug);
    expect(row.amountMinor).toBeNull();
  });

  it("leaves the money columns null when the intent matches no invoice", async () => {
    const orgId = await seedOrg();
    const comp = await seedComp(orgId, "legacy-cup");
    await grantPass(comp.id, orgId, `pi_${uniq()}`, "2026-02-01T09:00:00Z", "event_pass");
    // A pass bought before Task 13 turned on invoice_creation: a real charge,
    // but no invoice object behind it.
    stripeMock.list.mockResolvedValue({ data: [] });

    const [row] = await getPassPurchases(orgId);

    expect(row.competitionSlug).toBe(comp.slug);
    expect(row.amountMinor).toBeNull();
    expect(row.hostedInvoiceUrl).toBeNull();
  });

  it("lists only this org's passes", async () => {
    const mine = await seedOrg();
    const theirs = await seedOrg();
    const myComp = await seedComp(mine, "mine");
    const theirComp = await seedComp(theirs, "theirs");
    await grantPass(myComp.id, mine, null, "2026-01-01T09:00:00Z", "event_pass");
    await grantPass(theirComp.id, theirs, null, "2026-01-02T09:00:00Z", "event_pass");

    const rows = await getPassPurchases(mine);

    expect(rows.map((r) => r.competitionSlug)).toEqual([myComp.slug]);
  });

  it("returns an empty list for an org that holds no pass", async () => {
    const orgId = await seedOrg();
    expect(await getPassPurchases(orgId)).toEqual([]);
  });

  // SPEC-4 §9: `ended` mirrors the resolver lock (isPassLocked) — the badge the
  // billing page will render (SPEC-6 UI). A running competition's pass is
  // active; a completed/archived one, or one whose end date passed the 7-day
  // grace, is ended.
  it("marks the pass ended exactly when its competition is locked", async () => {
    const orgId = await seedOrg();
    const live = await seedComp(orgId, "live-cup");
    const done = await seedComp(orgId, "done-cup");
    const shelved = await seedComp(orgId, "shelved-cup");
    const lapsed = await seedComp(orgId, "lapsed-cup");
    await grantPass(live.id, orgId, null, "2026-01-01T09:00:00Z", "event_pass");
    await grantPass(done.id, orgId, null, "2026-01-02T09:00:00Z", "event_pass");
    await grantPass(shelved.id, orgId, null, "2026-01-03T09:00:00Z", "event_pass");
    await grantPass(lapsed.id, orgId, null, "2026-01-04T09:00:00Z", "event_pass");
    await setCompLifecycle(live.id, "live", null);
    await setCompLifecycle(done.id, "completed", null);
    await setCompLifecycle(shelved.id, "archived", null);
    // A live competition whose end date passed more than 7 days ago (grace).
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    await setCompLifecycle(lapsed.id, "live", eightDaysAgo);

    const byId = Object.fromEntries((await getPassPurchases(orgId)).map((r) => [r.competitionId, r]));

    expect(byId[live.id].ended).toBe(false);
    expect(byId[done.id].ended).toBe(true);
    expect(byId[shelved.id].ended).toBe(true);
    expect(byId[lapsed.id].ended).toBe(true);
  });
});

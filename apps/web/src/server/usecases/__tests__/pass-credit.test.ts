// Pass-to-Pro upgrade credit (v3/07, D12). A $29 Event Pass bought shortly
// before an upgrade is handed back as a CUSTOMER BALANCE CREDIT against the
// subscription — a coupon is not available, because Checkout rejects `discounts`
// alongside the `allow_promotion_codes` both session builders set.
//
// This suite exists because the feature moves real money in a schema that holds
// almost none of it: `competition_passes` (V271) is five columns with no amount,
// no currency and no refund flag, so every figure is a LIVE Stripe read and
// every read is a chance to credit cash nobody ever paid. Each test below pins
// one way that could go wrong:
//   - a staff-granted pass (NULL intent) was never paid for
//   - a refunded pass is worth nothing; a PARTIALLY refunded one is worth the net
//   - a credit in the wrong currency is dead money on the invoice
//   - a Stripe read we cannot make is not a licence to assume
//   - and the sharp one: create checkout, abandon, create again — ONE credit.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is mocked (the
// suite never has a key — vitest.config.ts deletes STRIPE_SECRET_KEY on
// purpose), with a stateful fake balance ledger so the idempotency test can run
// the whole path twice for real. Seeds are run-unique (randomUUID) and torn
// down in afterAll.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

interface FakeBalanceTxn {
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

const stripeMock = vi.hoisted(() => ({
  retrieveIntent: vi.fn(),
  listBalance: vi.fn(),
  createBalance: vi.fn(),
  /** true = getStripe() throws, exactly as it does with no STRIPE_SECRET_KEY. */
  fail: false,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    if (stripeMock.fail) throw new Error("STRIPE_SECRET_KEY is not set.");
    return {
      paymentIntents: { retrieve: stripeMock.retrieveIntent },
      customers: {
        listBalanceTransactions: stripeMock.listBalance,
        createBalanceTransaction: stripeMock.createBalance,
      },
    };
  },
}));

import { sql } from "@/lib/db";
import {
  PASS_CREDIT_INTENT_KEY,
  PASS_CREDIT_WINDOW_DAYS,
  creditPassTowardSubscription,
  orgHoldsAnyPass,
  withinCreditWindow,
} from "../pass-credit";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);
const orgIds: string[] = [];

/** Stands in for the customer's balance history; createBalanceTransaction
 *  appends to it and listBalanceTransactions reads it back, so running the
 *  credit path twice exercises the real idempotency check. */
const ledger: FakeBalanceTxn[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

async function seedOrg(opts: {
  customerId?: string | null;
  currency?: string | null;
  planKey?: string;
} = {}): Promise<string> {
  const suffix = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Credit Org " + suffix}, ${"credit-org-" + suffix}) returning id`;
  orgIds.push(id);
  await sql`
    insert into subscriptions (org_id, plan_key, status, stripe_customer_id, currency)
    values (${id}, ${opts.planKey ?? "community"}, 'active',
            ${opts.customerId === undefined ? "cus_" + suffix : opts.customerId},
            ${opts.currency === undefined ? "gbp" : opts.currency})`;
  return id;
}

async function seedPass(
  orgId: string,
  opts: { intent?: string | null; purchasedAt?: string; label?: string } = {},
): Promise<{ competitionId: string; intent: string | null }> {
  const suffix = uniq();
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${`${opts.label ?? "cup"} ${suffix}`}, ${`${opts.label ?? "cup"}-${suffix}`})
    returning id`;
  const intent = opts.intent === undefined ? `pi_${suffix}` : opts.intent;
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at)
    values (${competitionId}, ${orgId}, ${intent}, ${opts.purchasedAt ?? daysAgo(1)})`;
  return { competitionId, intent };
}

/** A succeeded PaymentIntent with its latest charge expanded, as
 *  paymentIntents.retrieve(id, { expand: ["latest_charge"] }) returns it. */
function paidIntent(
  opts: {
    captured?: number;
    refunded?: number;
    currency?: string;
    status?: string;
    chargeStatus?: string;
    disputed?: boolean;
    /** null = charge missing, string = unexpanded id. */
    charge?: null | string;
  } = {},
) {
  const captured = opts.captured ?? 2900;
  return {
    status: opts.status ?? "succeeded",
    currency: opts.currency ?? "gbp",
    amount_received: captured,
    latest_charge:
      opts.charge !== undefined
        ? opts.charge
        : {
            status: opts.chargeStatus ?? "succeeded",
            disputed: opts.disputed ?? false,
            amount_captured: captured,
            amount_refunded: opts.refunded ?? 0,
          },
  };
}

beforeEach(() => {
  ledger.length = 0;
  stripeMock.fail = false;
  stripeMock.retrieveIntent.mockReset().mockResolvedValue(paidIntent());
  stripeMock.listBalance.mockReset().mockImplementation(() => ({
    autoPagingToArray: async () => [...ledger],
  }));
  stripeMock.createBalance
    .mockReset()
    .mockImplementation(async (_customerId: string, params: FakeBalanceTxn) => {
      ledger.push(params);
      return { id: `cbtxn_${uniq()}` };
    });
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`delete from competition_passes where org_id = any(${orgIds})`;
    await sql`delete from competitions where org_id = any(${orgIds})`;
    await sql`delete from subscriptions where org_id = any(${orgIds})`;
    await sql`delete from organizations where id = any(${orgIds})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("withinCreditWindow", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("credits at exactly the window boundary and not one day past it", () => {
    const at30 = new Date(now.getTime() - PASS_CREDIT_WINDOW_DAYS * DAY_MS);
    const at31 = new Date(now.getTime() - (PASS_CREDIT_WINDOW_DAYS + 1) * DAY_MS);
    // "bought ≤30 days ago" — inclusive on 30, out on 31.
    expect(withinCreditWindow(at30, now)).toBe(true);
    expect(withinCreditWindow(at31, now)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("creditPassTowardSubscription", () => {
  it("credits the full pass payment as a NEGATIVE balance transaction", async () => {
    const orgId = await seedOrg();
    const { intent } = await seedPass(orgId, { purchasedAt: daysAgo(3) });

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("credited");
    expect(res.amountMinor).toBe(2900);
    expect(res.currency).toBe("gbp");
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    const [customerId, params] = stripeMock.createBalance.mock.calls[0];
    expect(customerId).toMatch(/^cus_/);
    // Negative is the credit direction. A positive amount would DEBIT the
    // customer — it would bill them a second $29 rather than credit one.
    expect(params.amount).toBe(-2900);
    expect(params.currency).toBe("gbp");
    // The intent is the only idempotency record there is; without it on the
    // transaction the second checkout attempt credits again.
    expect(params.metadata[PASS_CREDIT_INTENT_KEY]).toBe(intent);
  });

  it("issues ONE credit when the credit path runs twice — the abandoned-checkout case", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(2) });

    const first = await creditPassTowardSubscription(orgId);
    // User closes the embedded checkout without paying and starts it again.
    const second = await creditPassTowardSubscription(orgId);

    expect(first.outcome).toBe("credited");
    expect(second.outcome).toBe("already_credited");
    expect(second.amountMinor).toBe(0);
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
  });

  it("credits ONE pass — the most recent — never the sum of several", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(20), label: "spring" });
    await seedPass(orgId, { purchasedAt: daysAgo(10), label: "summer" });
    const newest = await seedPass(orgId, { purchasedAt: daysAgo(2), label: "autumn" });

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("credited");
    // Three passes at £29 each; the cap means £29, not £87.
    expect(res.amountMinor).toBe(2900);
    expect(res.paymentIntent).toBe(newest.intent);
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    // Only the newest intent was even looked up.
    expect(stripeMock.retrieveIntent).toHaveBeenCalledTimes(1);
    expect(stripeMock.retrieveIntent).toHaveBeenCalledWith(newest.intent, {
      expand: ["latest_charge"],
    });
  });

  it("gives nothing for a pass bought 31 days ago", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(31) });

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("outside_window");
    expect(res.amountMinor).toBe(0);
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("still credits a pass bought just inside the 30-day window", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, {
      purchasedAt: new Date(Date.now() - PASS_CREDIT_WINDOW_DAYS * DAY_MS + 60_000).toISOString(),
    });

    // Just inside 30 days credits — the boundary itself is pinned by the pure
    // withinCreditWindow test above, which needs no clock slop.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("credited");
  });

  it("gives nothing for a pass with NO payment intent — a staff grant nobody paid for", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { intent: null, purchasedAt: daysAgo(1) });

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("unpaid_pass");
    expect(res.amountMinor).toBe(0);
    // Nothing to correlate, so Stripe is never even asked.
    expect(stripeMock.retrieveIntent).not.toHaveBeenCalled();
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("lets a comp granted after a purchase shadow it, rather than reaching past it", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(5), label: "paid" });
    await seedPass(orgId, { intent: null, purchasedAt: daysAgo(1), label: "comped" });

    // "Cap at ONE pass — the most recent" is taken literally. Reaching past the
    // comp to the older paid pass is the only alternative, and it can only ever
    // credit MORE, so the conservative reading wins.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("unpaid_pass");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing for a fully refunded pass", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ captured: 2900, refunded: 2900 }));

    const res = await creditPassTowardSubscription(orgId);

    // The invoice behind a refunded charge still reads `paid`, which is exactly
    // why the amount comes off the CHARGE and not off the invoice.
    expect(res.outcome).toBe("nothing_owed");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("credits only the NET of a partially refunded pass", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ captured: 2900, refunded: 1000 }));

    const res = await creditPassTowardSubscription(orgId);

    // The brief names full refunds only. Partial refunds deliberately KEEP the
    // pass (revokePassForRefundedCharge revokes on `charge.refunded` alone), so
    // the row is still here and a policy is unavoidable. Net is the only one
    // that cannot credit money the customer did not keep paying.
    expect(res.outcome).toBe("credited");
    expect(res.amountMinor).toBe(1900);
    expect(stripeMock.createBalance.mock.calls[0][1].amount).toBe(-1900);
  });

  it("gives nothing for a disputed pass charge", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ disputed: true }));

    // Money that may still be clawed back is not money to hand out.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("nothing_owed");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing when the pass currency differs from the subscription currency", async () => {
    const orgId = await seedOrg({ currency: "usd" });
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ currency: "gbp" }));

    const res = await creditPassTowardSubscription(orgId);

    // A gbp balance credit does nothing for a usd invoice — it just sits on the
    // customer for ever.
    expect(res.outcome).toBe("currency_mismatch");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing when the org has no pinned billing currency to match against", async () => {
    const orgId = await seedOrg({ currency: null });
    await seedPass(orgId, { purchasedAt: daysAgo(4) });

    const res = await creditPassTowardSubscription(orgId);

    // preferredCurrency() would fall through to a cookie or Accept-Language, so
    // there is no currency to assert a match with. Assuming one is worse than
    // not crediting.
    expect(res.outcome).toBe("currency_unknown");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing when the org has no Stripe customer to credit", async () => {
    const orgId = await seedOrg({ customerId: null });
    await seedPass(orgId, { purchasedAt: daysAgo(4) });

    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("no_customer");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing when the payment intent cannot be read", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockRejectedValue(new Error("Stripe is down"));

    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("stripe_unreadable");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing, and does not throw, when Stripe has no key at all", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.fail = true;

    // A checkout must not 500 because the credit could not be worked out.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("stripe_unreadable");
  });

  it("gives nothing when the charge is not expanded, so refunds cannot be seen", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ charge: "ch_unexpanded" }));

    // Without the charge we cannot rule out a refund, and "probably not
    // refunded" is not a basis for moving money.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("stripe_unreadable");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("gives nothing when the payment intent never succeeded", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ status: "requires_payment_method" }));

    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("nothing_owed");
  });

  it("gives nothing, and reads no Stripe, for an org holding no pass", async () => {
    const orgId = await seedOrg();

    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("no_pass");
    expect(stripeMock.retrieveIntent).not.toHaveBeenCalled();
  });

  it("refuses to credit when the existing-credit check cannot be made", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(4) });
    stripeMock.listBalance.mockImplementation(() => ({
      autoPagingToArray: async () => {
        throw new Error("Stripe is down");
      },
    }));

    // Blind to the history means blind to a credit already issued; double
    // crediting is the failure that costs money, so this must decline.
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("already_credited");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("credits regardless of the plan the org is on — Pro and Pro Plus alike", async () => {
    // checkoutSchema.plan_key is z.enum(["pro","pro_plus"]), so the sole caller
    // cannot ask for anything else; the credit itself is plan-blind, and these
    // two orgs prove no plan_key path is privileged.
    const upgrading = await seedOrg({ planKey: "community" });
    const trialing = await seedOrg({ planKey: "pro" });
    await seedPass(upgrading, { purchasedAt: daysAgo(3) });
    await seedPass(trialing, { purchasedAt: daysAgo(3) });

    expect((await creditPassTowardSubscription(upgrading)).outcome).toBe("credited");
    expect((await creditPassTowardSubscription(trialing)).outcome).toBe("credited");
  });

  it("credits only against this org's own passes", async () => {
    const mine = await seedOrg();
    const theirs = await seedOrg();
    await seedPass(theirs, { purchasedAt: daysAgo(1) });

    expect((await creditPassTowardSubscription(mine)).outcome).toBe("no_pass");
  });
});

describe.skipIf(!HAS_DB)("orgHoldsAnyPass", () => {
  it("is true for a paid pass and for a staff-granted one", async () => {
    const paid = await seedOrg();
    const comped = await seedOrg();
    await seedPass(paid, { purchasedAt: daysAgo(400) });
    await seedPass(comped, { intent: null, purchasedAt: daysAgo(400) });

    // requireCard asks "has this org used the pass path", not "did they pay" —
    // and not "recently" either, so an old pass still forces card collection.
    expect(await orgHoldsAnyPass(paid)).toBe(true);
    expect(await orgHoldsAnyPass(comped)).toBe(true);
  });

  it("is false for an org that holds none", async () => {
    expect(await orgHoldsAnyPass(await seedOrg())).toBe(false);
  });
});

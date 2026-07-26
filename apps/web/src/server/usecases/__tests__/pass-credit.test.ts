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
  groupAlreadyRedeemed,
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
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id, currency)
      select coalesce(o.created_by, (select id from _owner)), ${opts.planKey ?? "community"}, 'active',
            ${opts.customerId === undefined ? "cus_" + suffix : opts.customerId},
            ${opts.currency === undefined ? "gbp" : opts.currency} from organizations o where o.id = ${id}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${id}`;
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
    // Orgs point AT subscriptions (V314), so capture the group ids, drop the
    // orgs to clear the FK, then the subscriptions they billed through.
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
      where id = any(${orgIds}) and subscription_id is not null`;
    await sql`delete from organizations o where o.id = any(${orgIds})`;
    if (groups.length)
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`;
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
    // The group-cap check (pass_credit_redemptions, V335) now runs BEFORE the
    // per-intent `alreadyCredited` scan, so an ordinary same-intent retry hits
    // the durable local row first and reads as `group_already_redeemed`, not
    // `already_credited` — that outcome is reserved for the narrower case
    // where the local row is missing (see "still recovers via the per-intent
    // scan" below) but Stripe already holds the credit.
    expect(second.outcome).toBe("group_already_redeemed");
    expect(second.amountMinor).toBe(0);
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
  });

  it("refuses a second pass in the same group, even on a different payment intent", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(5), label: "spring" });
    const first = await creditPassTowardSubscription(orgId);
    expect(first.outcome).toBe("credited");

    // A second, distinct pass — different competition, different intent — is
    // exactly the stacking defect (design 2026-07-26 §2): the group's ONE
    // lifetime credit is already spent, not this intent's.
    await seedPass(orgId, { purchasedAt: daysAgo(1), label: "autumn" });
    const second = await creditPassTowardSubscription(orgId);

    expect(second.outcome).toBe("group_already_redeemed");
    expect(second.amountMinor).toBe(0);
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
  });

  it("shares the group's ONE credit across two orgs on the same subscription", async () => {
    const orgA = await seedOrg();
    const [{ subscription_id: subscriptionId }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${orgA}`;
    const suffix = uniq();
    const [{ id: orgB }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, subscription_id)
      values (${"Credit Org " + suffix}, ${"credit-org-" + suffix}, ${subscriptionId})
      returning id`;
    orgIds.push(orgB);

    await seedPass(orgA, { purchasedAt: daysAgo(5) });
    await seedPass(orgB, { purchasedAt: daysAgo(1) });

    // This is the reason the cap is keyed on subscription_id and not org_id: a
    // group is one Stripe customer, so a per-org cap would let it collect one
    // £25 credit per member org.
    expect((await creditPassTowardSubscription(orgA)).outcome).toBe("credited");
    expect((await creditPassTowardSubscription(orgB)).outcome).toBe("group_already_redeemed");
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
  });

  it("frees the cap again once the redemption is reversed", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(5), label: "spring" });
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("credited");

    // Stands in for the Phase 2 admin refund action, which is the only thing
    // that will ever set this column in production.
    await sql`
      update pass_credit_redemptions set reversed_at = now()
      where org_id = ${orgId} and reversed_at is null`;

    await seedPass(orgId, { purchasedAt: daysAgo(1), label: "autumn" });
    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("credited");
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(2);
  });

  it("still recovers via the per-intent scan when the local row is missing", async () => {
    // Simulates the documented crash window: createBalanceTransaction
    // succeeded (the ledger has the entry, metadata and all) but the process
    // died before the INSERT into pass_credit_redemptions landed. The row this
    // test deletes is exactly what that crash would have left un-written.
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(2) });
    expect((await creditPassTowardSubscription(orgId)).outcome).toBe("credited");
    await sql`delete from pass_credit_redemptions where org_id = ${orgId}`;

    // groupAlreadyRedeemed now sees nothing, so the retry falls through to the
    // per-intent Stripe metadata scan — which still remembers, and still
    // refuses. Without this fallback, the missing row would let the retry
    // mint a second credit for the SAME intent.
    const retry = await creditPassTowardSubscription(orgId);
    expect(retry.outcome).toBe("already_credited");
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
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

  // ── The 23505 branch (money-bug regression, round 2) ──────────────────────
  // V335 carries TWO unique constraints on pass_credit_redemptions, and they
  // mean opposite things on conflict: `payment_intent unique` (the SAME
  // intent, an ordinary double-click — Stripe already deduped the two
  // createBalanceTransaction calls via idempotencyKey into ONE real credit,
  // so there is nothing to undo) vs `pass_credit_redemptions_group_cap` (a
  // DIFFERENT intent for the same group, a genuine race, a genuine second
  // credit that must be reversed). Treating every 23505 as the second case
  // — as the code used to — cancels the one legitimate credit on a same-intent
  // double-click and leaves the customer with a redemption row claiming money
  // that is no longer on their Stripe balance.

  it("a same-intent conflict reads as already_credited and never compensates", async () => {
    const orgId = await seedOrg();
    const { intent } = await seedPass(orgId, { purchasedAt: daysAgo(2) });

    // A row for this EXACT intent already exists, but under a DIFFERENT
    // group — the shape a real double-click race leaves behind (the winner's
    // insert lands between this org's own groupAlreadyRedeemed check, which
    // only looks at ITS OWN subscription, and its INSERT). No live suite
    // exercises this deterministically today, which is how it shipped.
    const otherOrgId = await seedOrg();
    const [{ subscription_id: otherSubId }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${otherOrgId}`;
    const { competitionId: otherCompId } = await seedPass(otherOrgId, {
      intent,
      purchasedAt: daysAgo(2),
      label: "other-group",
    });
    await sql`
      insert into pass_credit_redemptions
        (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency)
      values (${otherSubId}, ${otherOrgId}, ${otherCompId}, ${intent}, 2900, 'gbp')`;

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("already_credited");
    expect(res.amountMinor).toBe(0);
    // Exactly ONE createBalanceTransaction call — the grant this run made.
    // A bug that treats this as a lost race would call it a SECOND time to
    // reverse the credit it just gave; asserting count alone would not catch
    // that mistake, so pin the real balance too.
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(-2900);
    const net = ledger.reduce((sum, t) => sum + t.amount, 0);
    // The credit stands: net balance is still negative (a real credit), not
    // zero (which is what a wrongful reversal would produce).
    expect(net).toBe(-2900);
  });

  it("a group-cap conflict compensates, with an idempotency key, down to net zero", async () => {
    const orgId = await seedOrg();
    const { intent } = await seedPass(orgId, { purchasedAt: daysAgo(2) });
    const [{ subscription_id: subId }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${orgId}`;

    // A second org in the SAME group, whose redemption for a DIFFERENT
    // intent lands between this call's groupAlreadyRedeemed check and its own
    // INSERT — forced deterministically as a side effect of the mocked
    // Stripe call, which sits exactly between those two.
    const suffix = uniq();
    const [{ id: winnerOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, subscription_id)
      values (${"Winner Org " + suffix}, ${"winner-org-" + suffix}, ${subId})
      returning id`;
    orgIds.push(winnerOrgId);
    const { competitionId: winnerCompId, intent: winnerIntent } = await seedPass(winnerOrgId, {
      purchasedAt: daysAgo(1),
      label: "winner",
    });

    stripeMock.createBalance.mockImplementationOnce(async (_customerId: string, params: FakeBalanceTxn) => {
      ledger.push(params);
      await sql`
        insert into pass_credit_redemptions
          (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency)
        values (${subId}, ${winnerOrgId}, ${winnerCompId}, ${winnerIntent}, 2900, 'gbp')`;
      return { id: `cbtxn_${uniq()}` };
    });

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("group_already_redeemed");
    expect(res.amountMinor).toBe(0);
    // Two calls: the grant, then the compensating reversal.
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(2);
    const net = ledger.reduce((sum, t) => sum + t.amount, 0);
    expect(net).toBe(0);
    const [, reversalParams, reversalOpts] = stripeMock.createBalance.mock.calls[1]!;
    expect(reversalParams.amount).toBe(2900);
    expect(reversalOpts).toMatchObject({ idempotencyKey: `pass-credit-reversal-${intent}` });

    // Real state, not just call counts: exactly one LIVE redemption for the
    // group, and it belongs to the WINNER, not the org that lost the race.
    const rows = await sql<{ org_id: string }[]>`
      select org_id from pass_credit_redemptions
      where subscription_id = ${subId} and reversed_at is null`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(winnerOrgId);
  });

  it("an unrelated DB failure on the insert is its own outcome, not stripe_unreadable", async () => {
    const orgId = await seedOrg();
    await seedPass(orgId, { purchasedAt: daysAgo(2) });
    // amount_minor is a plain `int` column: this overflows it (a real
    // Postgres 22003, not 23505), so the credit itself is genuine — Stripe
    // was already told to move the money — but the local row cannot be
    // written. Mislabelling this stripe_unreadable would blame Stripe for a
    // schema fault that is entirely ours.
    stripeMock.retrieveIntent.mockResolvedValue(paidIntent({ captured: 3_000_000_000 }));

    const res = await creditPassTowardSubscription(orgId);

    expect(res.outcome).toBe("redemption_unrecorded");
    // The Stripe credit already happened and is real — no compensation is
    // owed (this is not the group-cap race), and it must not be re-tried
    // here either.
    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
  });

  it("an unrecognised constraint name reads as redemption_unrecorded, never already_credited", async () => {
    // Guards the exclusion this branch used to make: today the INSERT catch
    // names GROUP_CAP_CONSTRAINT and PAYMENT_INTENT_CONSTRAINT explicitly and
    // treats anything else as `redemption_unrecorded` — but a future
    // migration adding a THIRD unique constraint to this table must not fall
    // into `already_credited` by exclusion, which would skip a compensation
    // that might genuinely be owed. Forces a REAL Postgres 23505 under a
    // constraint name pass-credit.ts has never heard of, by adding a
    // temporary third unique constraint for the lifetime of this test alone
    // — not a hand-forged error object.
    const orgId = await seedOrg();
    const { competitionId } = await seedPass(orgId, { purchasedAt: daysAgo(2) });
    const [{ subscription_id: subId }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${orgId}`;

    await sql`
      alter table pass_credit_redemptions
        add constraint pass_credit_redemptions_test_unknown_unique unique (competition_id, currency)`;
    try {
      // A REVERSED row sharing (competition_id, currency) with the credit
      // this test is about to earn. reversed_at is set so it does NOT trip
      // GROUP_CAP_CONSTRAINT (that partial index ignores reversed rows), and
      // its payment_intent is a different string so PAYMENT_INTENT_CONSTRAINT
      // is not touched either — the ONLY constraint the real INSERT below can
      // hit is the temporary one just added.
      await sql`
        insert into pass_credit_redemptions
          (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency, reversed_at)
        values (${subId}, ${orgId}, ${competitionId}, ${"pi_unrelated_" + uniq()}, 2900, 'gbp', now())`;

      const res = await creditPassTowardSubscription(orgId);

      expect(res.outcome).toBe("redemption_unrecorded");
      expect(res.amountMinor).toBe(0);
      // The Stripe credit already happened and is real. An unrecognised
      // constraint must NOT be assumed to be the harmless same-intent case —
      // but it must also not be compensated as if it were a proven second
      // credit (that's the group-cap case only). Exactly one call: the
      // original grant, nothing more.
      expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.amount).toBe(-2900);
    } finally {
      await sql`
        alter table pass_credit_redemptions
          drop constraint if exists pass_credit_redemptions_test_unknown_unique`;
    }
  });

  it("groupAlreadyRedeemed fails CLOSED on a genuine DB fault, not open", async () => {
    // A real Postgres error (invalid uuid input), not a mock — this function
    // has no throw-safety net of its own (unlike alreadyCredited), so a fault
    // here must still read as "assume redeemed" rather than "assume clear and
    // race the unique index".
    await expect(groupAlreadyRedeemed("not-a-uuid")).resolves.toBe(true);
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

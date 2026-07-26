// RED test for the pass-credit lifetime cap (design 2026-07-26).
//
// EXPECTED TO FAIL until the redemption model ships. It is the reproduction of
// the defect that design exists for: observed live 2026-07-25 as
// `credited/-5000/2` — a second Event Pass mints a SECOND £25 credit, and the
// two stack on one Stripe customer with nothing capping the total. Five passes
// is £125 of credit, a free year of Pro, on top of five permanently upgraded
// competitions.
//
// The cause is a per-intent guard doing a per-group job: `mostRecentPass` caps
// a SINGLE grant at one pass ("not the sum"), but `alreadyCredited` only blocks
// re-crediting the SAME payment intent, so a second pass is simply a second
// intent. Nothing in Stripe or Postgres records that this group has already
// redeemed a pass.
//
// The assertions below are deliberately implementation-agnostic — they pin the
// MONEY (one credit, £25, one balance transaction) rather than the outcome name
// the fix will introduce, so the fix can name it whatever fits.
//
//   BILLING_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/pass-credit-stack.live.test.ts --testTimeout=60000
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { creditPassTowardSubscription } from "../pass-credit";
import { PASS_GBP, dropSeededOrgs, passFixture } from "./pass-credit-live-fixture";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;
const HAS_DB = !!process.env.DATABASE_URL;

const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  if (HAS_DB) await dropSeededOrgs();
});

describe.skipIf(!LIVE || !HAS_DB)("pass credit is capped per billing group", () => {
  // beforeAll, not describe-body scope — see pass-credit.live.test.ts: Vitest
  // evaluates this factory during collection even when skipIf is true, so
  // constructing here throws on every run without BILLING_LIVE=1.
  let stripe: Stripe;
  beforeAll(() => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  });

  it("credits ONE pass per group, however many passes are bought", async () => {
    // Pass A, credited, then the checkout is abandoned — no subscription. The
    // credit stays on the customer, which is correct today and under the new
    // design simply never happens (the grant moves to subscription start).
    const f = await passFixture(stripe);
    cleanup.push(() => stripe.customers.del(f.customerId));
    expect((await creditPassTowardSubscription(f.orgId)).outcome).toBe("credited");

    // Pass B: same org, same group, same Stripe customer, a second competition.
    const suffix = randomUUID().slice(0, 12);
    const piB = await stripe.paymentIntents.create({
      amount: PASS_GBP,
      currency: "gbp",
      customer: f.customerId,
      payment_method: "pm_card_visa",
      confirm: true,
      off_session: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `Event Pass B ${suffix}`,
    });
    const [{ id: compB }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${f.orgId}, ${"Probe Cup B " + suffix}, ${"probe-cup-b-" + suffix}) returning id`;
    await sql`
      insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at)
      values (${compB}, ${f.orgId}, ${piB.id}, now())`;

    const second = await creditPassTowardSubscription(f.orgId);

    // The group has already redeemed its one pass credit.
    expect(second.outcome).not.toBe("credited");
    expect(second.amountMinor).toBe(0);

    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-PASS_GBP);
    const txns = await stripe.customers.listBalanceTransactions(f.customerId, { limit: 10 });
    expect(txns.data).toHaveLength(1);
  }, 60_000);
});

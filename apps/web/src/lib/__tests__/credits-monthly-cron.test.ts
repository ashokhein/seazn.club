// v17 Task 6 (re-review, CRITICAL cadence fix): the daily cron entry point
// (api/cron/billing-grant) that grants every LIVE wallet its
// ai.credits.monthly(plan) * quantity_paid allowance — scaled for paid plans,
// flat for community (SPEC-2 §11.2); a TRIALING paid wallet scales by
// max(quantity_paid, live_org_count) instead (#291, see
// grantMonthlyForAllWallets' docstring). Each grant first expires any unspent
// grant-bucket leftover from the prior period (D1, use-or-lose, Task 6 review
// fix) before adding the new allowance. Idempotent per period: EVERY wallet —
// paid or Community — keys its period off the plain calendar month
// (`YYYY-MM`, server clock; README §7 item 7's anchor). This is deliberately
// NOT the Stripe billing-cycle boundary (`current_period_end`): SPEC-2 §5.4
// Cadence requires the grant to be monthly *regardless of billing cadence* —
// an annual Pro ($159/yr) still gets 60/mo × 12, not a 720 lump — and an
// annual subscription's `current_period_end` only advances once a year, so
// anchoring on it (a prior version of this cron did, for paid wallets) is a
// cadence regression, not an approximation.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { balance, grantBalance, grantMonthlyForAllWallets, utcMonthStart } from "@/lib/credits";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cron-${suffix}@test.local`}, 'Cron Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cron Org " + suffix}, ${"cron-org-" + suffix}, ${ownerId}) returning id`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.useRealTimers();
});

// grantMonthlyForAllWallets full-table-scans every subscription row with a
// live org in the schema on each call, plus one resolver read per row. Run in
// isolation that's instant (the whole file is ~6.5s for all 12 tests), but
// inside the FULL vitest run (thousands of fixture rows accumulated by every
// other suite in the same session) it can comfortably exceed vitest's default
// 5s per-test timeout — not a regression in the code path itself, just the
// cost of "every wallet" scaling with the whole test session's row count.
//
// (#363) This USED TO be handled by pinning a per-test `{ timeout: N }` on
// every `it(...)` here — which is exactly the wrong tool: a per-test timeout
// OVERRIDES `--testTimeout` on the CLI, it does not merely raise the floor.
// The repo-wide convention for slow-DB suites is the CLI flag (every gate/CI
// invocation runs `vitest ... --testTimeout=30000`), so a 20000ms inline pin
// here silently CAPPED this file below what every other suite in the same
// run was given — under real load the CLI's 30s margin never took effect,
// and the failure read as a hang ("Test timed out in 20000ms") rather than
// what it was: quiet slack the file had denied itself. No test in this file
// is individually slow enough to need its own bound (see the ~6.5s total
// above) — the CLI flag alone is sufficient, so none is pinned inline.
// Anyone tempted to re-add one: it will silently defeat `--testTimeout`
// again, whatever value that flag is given.

describe.skipIf(!HAS_DB)("grantMonthlyForAllWallets (billing-grant cron)", () => {
  it("grants a paid wallet the scaled amount (monthly(plan) * quantity_paid)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update subscriptions set quantity_paid = 3 where id = ${subId}`;

    // Left unscoped, deliberately: this is the one case in the file that
    // still exercises the unfiltered (every-wallet) query shape the cron
    // itself uses. `wallets` is therefore a schema-wide aggregate a sibling
    // suite can move (#321/#351), so it gets a loose assertion; this wallet's
    // own balance does not move regardless of how many others exist.
    const res = await grantMonthlyForAllWallets();

    expect(res.wallets).toBeGreaterThan(0);
    expect(await balance(subId)).toBe(60 * 3);
  });

  it("grants a community wallet the FLAT 10, ignoring quantity_paid", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");
    // Even if quantity_paid were ever non-1 on a community group-of-one,
    // Community is never seat-scaled (SPEC-2 §11.2 — "never grouped").
    await sql`update subscriptions set quantity_paid = 5 where id = ${subId}`;

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(await balance(subId)).toBe(10);
  });

  it("is a no-op on a second run in the same calendar month (idempotent per period)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro_plus");

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(200);

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(200);
  });

  it("REGRESSION (#290): grants the resolved Community rate for a canceled (churned) subscription, not zero", async () => {
    const orgId = await seedOrg();
    // comped_at stays null (setOrgPlan's default) — orgPlanKey's `canceled`
    // arm degrades this to community, exactly like any other entitlement
    // read of this org (hasFeature, getLimit, the billing page).
    const subId = await setOrgPlan(orgId, "pro", "canceled");

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    // Before #290 the raw status filter (`status in ('trialing','active',
    // 'past_due')`) skipped this row entirely — a churned org got 0 credits
    // forever even though every OTHER entitlement read already resolves it
    // to Community and expects the Community grant to back that up.
    expect(await balance(subId)).toBe(10);
  });

  it("REGRESSION (#290): grants the resolved Community rate for an incomplete (never-paid) subscription", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "incomplete");

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(await balance(subId)).toBe(10);
  });

  it("expires the prior period's unspent grant balance before granting the new period (D1)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    // Leftover from a prior period the wallet never spent.
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${subId}, 15, 'monthly_grant', 'grant', 15, ${`seed-${randomUUID().slice(0, 8)}`})`;
    expect(await grantBalance(subId)).toBe(15);

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    // Not 15 + 60 banked — expired then re-granted to exactly this period's amount.
    expect(await grantBalance(subId)).toBe(60);
    expect(await balance(subId)).toBe(60);
  });

  it("a paid wallet's period is the calendar month, never current_period_end — a Stripe cycle change within the same month is a no-op", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    const cycle1 = new Date("2026-07-05T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle1} where id = ${subId}`;

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(60);

    // Same calendar month, same period boundary — a second poll (e.g. the
    // next day's cron run) must be a no-op.
    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(60);

    // Stripe rolls the subscription to a new cycle (webhook sync advances
    // current_period_end) but we're still in the SAME calendar month — this
    // must stay a no-op. Anchoring on current_period_end (the pre-fix
    // behavior) would have expired + re-granted here; the fix must not.
    const cycle2 = new Date("2026-07-19T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle2} where id = ${subId}`;

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await grantBalance(subId)).toBe(60); // still exactly one month's grant, not 120
    expect(await balance(subId)).toBe(60);
  });

  it("Community wallets grant on plain calendar month (no Stripe period at all)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");
    const [row] = await sql<{ current_period_end: string | null }[]>`
      select current_period_end from subscriptions where id = ${subId}`;
    expect(row?.current_period_end).toBeNull();

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(10);

    await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(await balance(subId)).toBe(10); // still idempotent via the calendar-month key
  });

  it("REGRESSION (SPEC-2 §5.4 Cadence): an annual (yearly-renewing) Pro subscription still grants 12x/year, not a single lump", async () => {
    // grantMonthlyForAllWallets scans every LIVE subscription row in the
    // schema each call; this test calls it across simulated months, which —
    // on a long-running local schema with many accumulated fixture rows —
    // can exceed vitest's default 5s per-test timeout
    // ([[feedback_run_live_billing_tests]]-adjacent gotcha, not a real
    // slowdown in the code path itself).
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    // Simulate an ANNUAL Stripe cycle: current_period_end sits a full year
    // out and never moves across this test — exactly the shape that made
    // the old current_period_end-anchored cron grant only ONCE for the
    // whole year (60, not 720/12mo). The fix must grant fresh credits every
    // calendar month regardless.
    await sql`
      update subscriptions
         set current_period_end = ${new Date("2027-06-01T00:00:00Z")}
       where id = ${subId}`;

    vi.useFakeTimers({ now: new Date("2026-06-05T00:00:00Z"), toFake: ["Date"] });

    // Scoped to THIS wallet (#351). An unscoped sweep here is the worst of the
    // family: it runs four times, under FAKE TIMERS, so every wallet a sibling
    // suite happens to own is swept at a simulated date it never agreed to —
    // and the scan itself grows with everything the session has accumulated,
    // which is what the 30s timeout above was compensating for.
    const only = { walletIds: [subId] };

    await grantMonthlyForAllWallets(only);
    expect(await balance(subId)).toBe(60); // month N

    // Same calendar month — a second poll must stay a no-op.
    await grantMonthlyForAllWallets(only);
    expect(await balance(subId)).toBe(60);

    // Advance to month N+1 — current_period_end is UNCHANGED (still a year
    // out), yet a fresh grant must land: cadence is monthly, not
    // billing-cycle.
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    await grantMonthlyForAllWallets(only);
    expect(await grantBalance(subId)).toBe(60); // reset to this month's own 60, not banked to 120
    expect(await balance(subId)).toBe(60);

    // ...and month N+2, proving this isn't a one-off double-grant fluke —
    // 3 calendar months in, 3 grants, still 60 in the bucket each time
    // (180 total ever granted across the ledger, use-or-lose resets each).
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    await grantMonthlyForAllWallets(only);
    expect(await grantBalance(subId)).toBe(60);
    expect(await balance(subId)).toBe(60);
  });

  it("REGRESSION (#291): a trialing group grants for the LIVE org count when quantity_paid is frozen below it", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "trialing");
    // #279 (syncGroupQuantity) freezes quantity_paid at its pre-trial
    // baseline through the whole trial — simulate a second org that rode the
    // trial for free without quantity_paid ever moving off its default (1).
    const suffix = randomUUID().slice(0, 8);
    await sql`
      insert into organizations (name, slug, subscription_id)
      values (${"Rider " + suffix}, ${"rider-" + suffix}, ${subId})`;

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    // max(quantity_paid=1, liveOrgCount=2) — not quantity_paid alone, or the
    // rider org would spend against a wallet that only ever got 1 seat's
    // worth of monthly credits.
    expect(await balance(subId)).toBe(60 * 2);
  });

  it("can be scoped to named wallets, so a parallel suite's wallets cannot move the answer (#351)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update subscriptions set quantity_paid = 2 where id = ${subId}`;
    const other = await seedOrg();
    const otherSub = await setOrgPlan(other, "pro");
    await sql`update subscriptions set quantity_paid = 1 where id = ${otherSub}`;

    const res = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(res.wallets).toBe(1);
    expect(await balance(subId)).toBe(60 * 2);
    expect(await balance(otherSub)).toBe(0); // untouched: not in scope
  });

  it("REGRESSION (#291): a trialing group still grants for quantity_paid when it sits ABOVE the live org count", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "trialing");
    // The other direction of the max(): this customer PAID for 3 seats before
    // the trial and orgs have since left (or never been created), so the live
    // count is 1. The grant must not shrink to what's live — they are still
    // entitled to the 3 seats' worth they're being billed for. Pins the
    // `quantity_paid` half of max(); without it, `live_org_count` alone would
    // satisfy every other test in this file.
    await sql`update subscriptions set quantity_paid = 3 where id = ${subId}`;

    await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(await balance(subId)).toBe(60 * 3);
  });

  // #390 — the sweep runs DAILY but grants MONTHLY, so on 30 of 31 days every
  // wallet it opened was already granted. The anti-join moves that skip from
  // "one round trip per wallet discovers a no-op" into the sweep's own WHERE.
  // `wallets` therefore means "wallets this run CONSIDERED", not "every
  // subscription in the schema" — the assertions below pin that new meaning.
  it("does not re-consider a wallet already granted this period (#390)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro_plus");

    const first = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(first.wallets).toBe(1);
    expect(first.granted).toBe(200);

    // Second run the same month: the wallet is filtered out by the sweep
    // itself, so it is never opened, locked, or re-read.
    const second = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(second.wallets).toBe(0);
    expect(second.granted).toBe(0);
    expect(await balance(subId)).toBe(200);
  });

  it("still grants a wallet that has no key for this period (#390)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    const res = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(res.wallets).toBe(1);
    expect(res.granted).toBeGreaterThan(0);
  });

  it("#390: the anti-join is a pre-filter, not the guard — a concurrent double-run still grants once", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro_plus");
    // Both calls pass the anti-join (neither sees a key yet); the advisory
    // lock and the in-transaction key check must still make exactly one of
    // them win. If the anti-join were ever mistaken for the guard, this is
    // the test that catches it.
    const [a, b] = await Promise.all([
      grantMonthlyForAllWallets({ walletIds: [subId] }),
      grantMonthlyForAllWallets({ walletIds: [subId] }),
    ]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.granted + b.granted).toBe(200);
    expect(await balance(subId)).toBe(200);
  });

  it("#390: a zero-grant plan keeps re-qualifying, and that is harmless", async () => {
    // `delta <= 0` returns BEFORE the idempotency key is written, so a wallet
    // whose plan grants nothing never writes one and comes back every day.
    // Documented, not fixed by the anti-join alone — and the reason Task 11
    // resolves the grant amount in the sweep rather than per row.
    //
    // The zero-grant plan here is `event_pass`, NOT `community`: community
    // carries `ai.credits.monthly = 10` (V320), so it grants, writes a key,
    // and IS filtered out on the second run. Event Pass deliberately carries
    // no `ai.credits.monthly` row at all — it is the only plan in the matrix
    // whose monthly grant is genuinely zero (scripts/smoke.ts says so too).
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "event_pass");

    const first = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(first.granted).toBe(0);

    const second = await grantMonthlyForAllWallets({ walletIds: [subId] });
    expect(second.wallets).toBe(first.wallets); // still considered — no key was ever written
    expect(second.granted).toBe(0);
    expect(await balance(subId)).toBe(0);
  });

  it("#390: grants three different plans their own rate in ONE sweep", async () => {
    // The observable guard on resolving the grant amount in the sweep rather
    // than per row: a single hoisted `ai.credits.monthly` read invites exactly
    // one failure mode — smearing the first plan's rate across every wallet.
    // Three plans that disagree is the only shape that can catch it; a sweep
    // of same-plan wallets is satisfied by the bug.
    const [proOrg, plusOrg, commOrg] = await Promise.all([seedOrg(), seedOrg(), seedOrg()]);
    const pro = await setOrgPlan(proOrg, "pro");
    const plus = await setOrgPlan(plusOrg, "pro_plus");
    const comm = await setOrgPlan(commOrg, "community");

    const res = await grantMonthlyForAllWallets({ walletIds: [pro, plus, comm] });

    expect(res.wallets).toBe(3);
    expect(res.failed).toBe(0);
    expect(await balance(pro)).toBe(60);
    expect(await balance(plus)).toBe(200);
    expect(await balance(comm)).toBe(10);
    expect(res.granted).toBe(60 + 200 + 10);
  });

  it("#390: a re-qualifying zero-grant wallet costs one statement per wallet, not two", async () => {
    const orgs = await Promise.all([seedOrg(), seedOrg(), seedOrg(), seedOrg()]);
    const subs = await Promise.all(orgs.map((o) => setOrgPlan(o, "event_pass")));

    const before = statementCount();
    const res = await grantMonthlyForAllWallets({ walletIds: subs });
    const used = statementCount() - before;

    expect(res.wallets).toBe(subs.length);
    expect(res.granted).toBe(0);

    // Budget, DERIVED not fitted: the sweep itself (1) + one `orgPlanKey`
    // resolve per wallet (N) + ONE batched `ai.credits.monthly` read covering
    // every distinct plan key (1) = N + 2.
    //
    // Event Pass carries no `ai.credits.monthly` row, so `delta <= 0` returns
    // before any transaction is opened — this measures the PURE per-row
    // overhead with no grant work mixed in. It is also the population that
    // pays it every single day: a zero-grant wallet never writes an
    // idempotency key, so the #390 anti-join can never filter it out. If the
    // sweep's per-row cost is going to matter anywhere, it is here.
    //
    // Before this change it was 1 + 2N — `grantMonthly` did its own
    // `plan_entitlements` read per wallet on top of `orgPlanKey`'s.
    //
    // `orgPlanKey` stays one query per row on purpose: it is a seven-arm
    // resolver (comp expiry, past_due grace, trial backstop, incomplete,
    // canceled, org suspension) and the app has already paid for three
    // divergent copies of it once. A cron with its own subtly different plan
    // resolution would grant the WRONG AMOUNT — far worse than an N+1.
    expect(used).toBeLessThanOrEqual(subs.length + 2);
  });

  // #390 edges. The six above pin the anti-join's happy path; these pin the
  // ways it could quietly stop being a PRE-FILTER and start being a bug —
  // wrong period scope, wrong empty-scope branch, wrong population.
  //
  // (A plan carrying no `ai.credits.monthly` row at all is NOT re-pinned here:
  // "#390: a zero-grant plan keeps re-qualifying, and that is harmless" above
  // already seeds `event_pass` — the matrix's only genuinely zero-grant plan —
  // and asserts a 0 grant and a 0 balance with nothing thrown.)

  it("#390: a wallet granted in the PREVIOUS month still qualifies this month — the anti-join is period-scoped, not 'ever granted'", async () => {
    // The single highest-consequence way to get the anti-join wrong: match on
    // any `monthly:<wallet>:%` key rather than THIS period's. Nothing else in
    // this file would notice — every other test grants inside one period — and
    // the production symptom is that monthly grants stop, permanently and
    // silently, for every wallet that has ever been granted once.
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");

    const now = new Date();
    const priorPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${subId}, 60, 'monthly_grant', 'grant', 60, ${`monthly:${subId}:${priorPeriod}`})`;

    const res = await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(res.wallets).toBe(1); // considered, despite last month's key
    expect(res.granted).toBe(60);
    expect(res.failed).toBe(0);
    // Last month's 60 was expired (D1 use-or-lose) and this month's granted —
    // exactly one month's allowance in the bucket, not a banked 120.
    expect(await grantBalance(subId)).toBe(60);
    expect(await balance(subId)).toBe(60);
  });

  it("#390: a MIXED sweep considers only the wallets still missing this period's key", async () => {
    // Every #390 test above sweeps one wallet at a time, so a `wallets` count
    // of 1 vs 0 is all they can distinguish. This is the shape the daily cron
    // actually meets: most of the batch already granted, a few not.
    const orgs = await Promise.all([seedOrg(), seedOrg(), seedOrg(), seedOrg()]);
    const [a, b, c, d] = await Promise.all(orgs.map((o) => setOrgPlan(o, "pro")));

    await grantMonthlyForAllWallets({ walletIds: [a!, b!] });

    const res = await grantMonthlyForAllWallets({ walletIds: [a!, b!, c!, d!] });

    expect(res.wallets).toBe(2); // c and d only — a and b never opened
    expect(res.granted).toBe(60 * 2);
    expect(res.failed).toBe(0);
    for (const sub of [a!, b!, c!, d!]) expect(await balance(sub)).toBe(60);
    // ...and the already-granted pair got exactly one grant row each, not two.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger
       where wallet_id in ${sql([a!, b!])} and source = 'monthly_grant'`;
    expect(n).toBe(2);
  });

  it("#390: the UNSCOPED sweep — the shape the cron itself runs — honours the anti-join too", async () => {
    // `walletIds` is a test affordance; the anti-join has to hold on the call
    // shape production uses, where the scope clause is absent entirely.
    const [orgA, orgB] = await Promise.all([seedOrg(), seedOrg()]);
    const [subA, subB] = await Promise.all([
      setOrgPlan(orgA!, "pro"),
      setOrgPlan(orgB!, "pro"),
    ]);
    await grantMonthlyForAllWallets({ walletIds: [subA, subB] });

    // Wallets already carrying this period's key, counted BEFORE the sweep —
    // subA and subB at minimum, which is what keeps the bound below
    // non-vacuous.
    const period = utcMonthStart().toISOString().slice(0, 7);
    const [{ keyed }] = await sql<{ keyed: number }[]>`
      select count(*)::int as keyed from subscriptions s
       where exists (select 1 from organizations o
                      where o.subscription_id = s.id and o.deleted_at is null)
         and exists (select 1 from ai_credit_ledger l
                      where l.idempotency_key = 'monthly:' || s.id::text || ':' || ${period})`;
    expect(keyed).toBeGreaterThanOrEqual(2);

    const swept = await grantMonthlyForAllWallets();

    expect(await balance(subA)).toBe(60); // one grant each, not two
    expect(await balance(subB)).toBe(60);

    // ...and neither was even CONSIDERED. `total` is the population the sweep
    // would have opened WITHOUT the anti-join (every subscription with a live
    // org), read AFTER the run: pairing an after-total with a before-keyed
    // means a sibling suite's concurrent insert can only LOOSEN this bound,
    // never tighten it into a flake (#351). Drop the anti-join and
    // `swept.wallets` becomes the whole population, overshooting by `keyed`.
    const [{ total }] = await sql<{ total: number }[]>`
      select count(*)::int as total from subscriptions s
       where exists (select 1 from organizations o
                      where o.subscription_id = s.id and o.deleted_at is null)`;
    expect(swept.wallets).toBeLessThanOrEqual(total - keyed);
  });

  it("#390: an explicitly EMPTY scope grants nothing — it must not fall through to the every-wallet branch", async () => {
    // `opts.walletIds ?? null` only nulls out undefined, and `[]` is truthy in
    // JS — so an empty array is a real, if unusual, caller intent ("sweep these
    // zero wallets"), not an absent scope. It must mean nothing, not everything.
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");

    const res = await grantMonthlyForAllWallets({ walletIds: [] });

    expect(res.wallets).toBe(0);
    expect(res.granted).toBe(0);
    expect(res.failed).toBe(0);
    expect(await balance(subId)).toBe(0); // untouched — an unscoped fall-through would have granted it
  });

  it("skips a wallet whose only org is soft-deleted — the live-org lateral is a CROSS join", async () => {
    // Both laterals filter `deleted_at is null`, and they are CROSS joins: a
    // group whose every org is soft-deleted produces no `rep` row, so the
    // subscription drops out of the sweep entirely. Turning either into a LEFT
    // join would surface a null `rep_org_id` and hand it to `orgPlanKey`.
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update organizations set deleted_at = now() where id = ${orgId}`;

    const res = await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(res.wallets).toBe(0);
    expect(res.granted).toBe(0);
    expect(res.failed).toBe(0); // not considered at all — never a resolve failure
    expect(await balance(subId)).toBe(0);
  });

  it("a paid wallet with quantity_paid = 0 grants nothing and writes NO ledger row (never a negative one)", async () => {
    // The seat count, not the plan, is what zeroes this one: `perSeat * qty`
    // hits `delta <= 0` and returns before the transaction opens (credits.ts).
    // The row worth guarding against is a NEGATIVE grant — `balance_after >= 0`
    // would reject it, so the sweep would report `failed`, not a bad balance.
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update subscriptions set quantity_paid = 0 where id = ${subId}`;

    const res = await grantMonthlyForAllWallets({ walletIds: [subId] });

    expect(res.wallets).toBe(1); // considered — no key was ever written for it
    expect(res.granted).toBe(0);
    expect(res.failed).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger where wallet_id = ${subId}`;
    expect(n).toBe(0); // no grant row, no expiry row, no key
    expect(await balance(subId)).toBe(0);
  });
});

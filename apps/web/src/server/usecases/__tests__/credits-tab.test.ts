// v17 SPEC-6 §A3 — the Credits-tab view model (server/usecases/credits-tab.ts).
// Real-Postgres integration test: skips without DATABASE_URL. Exercises the
// pure read/derive over the ledger — balance, the grant meter (this month's
// grant-bucket run_spend, clamped), never-expire packs, shared-org count, and
// the run history mapping.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  grantMonthly,
  mergeWalletOnAttach,
  recordEarnGrant,
  recordPackPurchase,
  reserve,
  settle,
  walletIdFor,
} from "@/lib/credits";
import { orgGroupId } from "@/lib/__tests__/_billing-group";
import { seedOrg } from "./_seed";
import { creditHistory, getCreditsTab } from "../credits-tab";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("getCreditsTab", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("derives balance, grant meter, packs and history for a Pro wallet", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);

    expect(await grantMonthly(walletId, "pro", 1)).toBe(60);
    expect(await recordPackPurchase(walletId, 100, `pack-${randomUUID()}`)).toBe(100);
    const hold = await reserve(walletId, auth.orgId, 1);
    await settle(hold, randomUUID());

    const view = await getCreditsTab(auth.orgId);

    expect(view.balance).toBe(159); // 60 grant + 100 pack − 1 spend
    expect(view.grantCap).toBe(60);
    expect(view.grantUsed).toBe(1); // one grant credit spent this period
    expect(view.packBalance).toBe(100);
    expect(view.sharedOrgCount).toBe(1);
    expect(view.grantResetsInDays).toBeGreaterThan(0);
    expect(view.grantResetsInDays).toBeLessThanOrEqual(31);

    expect(view.history).toHaveLength(3);
    const run = view.history.find((r) => r.action === "run");
    expect(run?.delta).toBe(-1);
    expect(view.history.find((r) => r.action === "monthlyGrant")?.delta).toBe(60);
    expect(view.history.find((r) => r.action === "pack")?.delta).toBe(100);
    // No ai_runs table yet — model/competition are null, org names present.
    expect(run?.model).toBeNull();
    expect(run?.competitionName).toBeNull();
  });

  it("caps the grant meter at the Community flat 10 and starts empty", async () => {
    const { auth } = await seedOrg("community");

    const view = await getCreditsTab(auth.orgId);
    expect(view.grantCap).toBe(10);
    expect(view.grantUsed).toBe(0);
    expect(view.balance).toBe(0);
    expect(view.sharedOrgCount).toBe(1);
    expect(view.history).toHaveLength(0);
  });

  // v17 gap #291, second call site: `grantMonthlyForAllWallets` grants a
  // TRIALING wallet on max(quantity_paid, liveOrgCount) because
  // syncGroupQuantity freezes quantity_paid for the whole trial. The tab's
  // grantCap divided by the frozen quantity_paid alone, so a trialing group
  // with a mid-trial rider read "used 70 / 60" — a meter over its own cap.
  it("scales the trialing grant cap to live orgs, matching what was actually granted", async () => {
    const { auth } = await seedOrg("pro");
    const groupId = (await orgGroupId(auth.orgId))!;
    await sql`update subscriptions set status = 'trialing', quantity_paid = 1 where id = ${groupId}`;

    // A second org rides the trial free: live count 2, quantity_paid still 1.
    const { auth: rider } = await seedOrg("community");
    await sql`update organizations set subscription_id = ${groupId} where id = ${rider.orgId}`;

    const walletId = await walletIdFor(auth.orgId);
    expect(await grantMonthly(walletId, "pro", 2)).toBe(120); // what the sweep grants
    const hold = await reserve(walletId, auth.orgId, 70);
    await settle(hold, randomUUID());

    const view = await getCreditsTab(auth.orgId);
    expect(view.grantCap).toBe(120); // NOT 60 — 70 used must not exceed the cap
    expect(view.grantUsed).toBe(70);
    expect(view.sharedOrgCount).toBe(2);
  });

  // The other side of the same rule: the trial max() must NOT leak into an
  // ACTIVE sub. Once billing is live, quantity_paid is no longer frozen —
  // syncGroupQuantity tracks the org count — so an extra live org that is not
  // yet paid for must not inflate the cap above what was granted.
  it("does NOT scale an ACTIVE sub's cap to live orgs — quantity_paid is the cap", async () => {
    const { auth } = await seedOrg("pro");
    const groupId = (await orgGroupId(auth.orgId))!;
    await sql`update subscriptions set status = 'active', quantity_paid = 1 where id = ${groupId}`;

    const { auth: extra } = await seedOrg("community");
    await sql`update organizations set subscription_id = ${groupId} where id = ${extra.orgId}`;

    const walletId = await walletIdFor(auth.orgId);
    expect(await grantMonthly(walletId, "pro", 1)).toBe(60); // what the sweep grants

    const view = await getCreditsTab(auth.orgId);
    expect(view.grantCap).toBe(60); // NOT 120 — the trial max() must not apply
    expect(view.sharedOrgCount).toBe(2);
  });

  it("REGRESSION (#292): the used-this-month meter excludes a hold recorded 30 minutes before the UTC month boundary", async () => {
    const [{ tz }] = await sql<{ tz: string }[]>`select current_setting('TimeZone') as tz`;
    // getCreditsTab has no tx to force a TZ on (see this task's Testability
    // note) — this only reproduces under a non-UTC ambient session TimeZone
    // (Europe/London here and in production). Skip cleanly rather than
    // false-fail on a UTC-default DB.
    if (tz === "UTC" || tz === "Etc/UTC") return;

    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await grantMonthly(walletId, "pro", 1);

    // 23:30 UTC on the last day of the PRIOR month — under the ambient
    // Europe/London (BST, UTC+1) session TZ this instant reads as "00:30"
    // on the 1st, an hour INTO the new month locally, so a session-TZ-
    // anchored boundary wrongly counts it. Computed relative to Postgres's
    // own clock so this holds on any run date, not hardcoded.
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
         idempotency_key, created_at)
      values (${walletId}, -7, 'run_spend', 'grant', ${auth.orgId}, 53,
              ${`edge-${randomUUID()}`},
              date_trunc('month', now() at time zone 'utc') at time zone 'utc' - interval '30 minutes')`;

    const view = await getCreditsTab(auth.orgId);

    expect(view.grantUsed).toBe(0); // must NOT count toward the current UTC month
  });

  // v17 gap #285: credits that arrive because the org joined a billing group
  // (mergeWalletOnAttach's `group_merge` rows) must be labelled as their own
  // thing. The actionKey mapping's `default:` arm returned "adminAdjust", so
  // the customer — and support reading the same tab — saw a wallet merge as a
  // staff "Account adjustment", which is a lie about where the money came from.
  it("labels a wallet merged on billing-group attach as groupMerge, not a staff adjustment", async () => {
    const { auth } = await seedOrg("community");
    const walletId = await walletIdFor(auth.orgId);
    const departing = randomUUID();
    await recordPackPurchase(departing, 25, `pack-${randomUUID()}`);

    await sql.begin((tx) => mergeWalletOnAttach(tx, departing, walletId));

    const history = await creditHistory(walletId);
    expect(history).toHaveLength(1);
    expect(history[0]!.delta).toBe(25);
    expect(history[0]!.action).toBe("groupMerge");
    expect(history[0]!.action).not.toBe("adminAdjust");
  });

  // #267 (SPEC-5 §2): the Invite & earn card's view fields — a minted,
  // stable referral code; how many orgs this org referred; and credits
  // earned AS THE REFERRER only (`earn:referral:*`), never conflated with a
  // referred org's own `earn:referral_welcome:*` grant on its own wallet.
  it("surfaces the referral code, referred-org count and referrer earnings", async () => {
    const { auth } = await seedOrg("community");
    const walletId = await walletIdFor(auth.orgId);

    const first = await getCreditsTab(auth.orgId);
    expect(first.referralCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(first.referredCount).toBe(0);
    expect(first.referralEarned).toBe(0);

    // getOrCreateReferralCode never regenerates once set.
    const second = await getCreditsTab(auth.orgId);
    expect(second.referralCode).toBe(first.referralCode);

    const { auth: referredOrg } = await seedOrg("community");
    await sql`
      update organizations set referred_by_org_id = ${auth.orgId}
       where id = ${referredOrg.orgId}`;

    const referredKey = randomUUID();
    await recordEarnGrant(walletId, referredOrg.orgId, "referral", referredKey, 20);
    // A referred org's OWN welcome grant lives on a different wallet and a
    // different idempotency-key namespace — must not leak into this org's
    // `referralEarned` even if (by coincidence of test setup) it shared a
    // wallet, so assert the `like` boundary explicitly with a near-miss key.
    await recordEarnGrant(walletId, auth.orgId, "referral_welcome", randomUUID(), 10);

    const view = await getCreditsTab(auth.orgId);
    expect(view.referredCount).toBe(1);
    expect(view.referralEarned).toBe(20);
  });
});

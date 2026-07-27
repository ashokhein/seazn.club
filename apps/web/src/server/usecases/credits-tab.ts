import "server-only";
import { sql } from "@/lib/db";
import { balance, packBalance, utcMonthStart, walletIdFor } from "@/lib/credits";
import { getOrCreateReferralCode } from "@/lib/referral";

/**
 * The AI-credit wallet home (SPEC-6 §A3): everything the org billing page's
 * **Credits** tab renders — pooled balance, this-month grant meter, never-expire
 * packs, and the run history. A READ-ONLY view over `lib/credits.ts`'s wallet
 * (whose spend/grant functions this must not touch) plus the plan's monthly
 * grant cap and the shared-pool org count.
 *
 * All numbers are derived from the append-only ledger + the plan matrix — there
 * is no `spent_this_period` counter to drift (see `credits.ts` for why the
 * ledger is the single source of truth).
 */

/** One line in the run-history table. `model`/`competitionName` are nullable by
 *  design: the ledger records the spend (date, source, delta, which org burned
 *  it) but not yet the model or competition — there is no `ai_runs` table, so a
 *  `run_spend` row's `ref` is a synthetic id that joins to nothing. Those two
 *  columns light up when an `ai_runs` table lands (the query already LEFT-shapes
 *  for it); until then they render as "—". */
export interface CreditHistoryRow {
  dateIso: string;
  /** A stable action key the UI maps to an i18n label
   *  (`billing.credits.action.*`) — never raw English, so a staff `reason_code`
   *  is categorised here and never leaked to the org. */
  action: string;
  model: string | null;
  /** Signed: +grant / −spend, as stored on the ledger row. */
  delta: number;
  competitionName: string | null;
  /** Which org in a shared pool the row belongs to (a `run_spend`'s
   *  `spent_by_org_id`), for the grouped-wallet case. Null for pool-level rows
   *  (grants, packs, expiries). */
  orgName: string | null;
}

export interface CreditsTabView {
  /** Pooled balance = `sum(ledger.delta)` (grant + pack). */
  balance: number;
  /** Grant credits consumed this period = this month's grant-bucket `run_spend`,
   *  clamped to [0, grantCap]. NOT `grantCap − grantBalance`: a never-granted org
   *  has grantBalance 0 yet has used nothing, which that formula would misreport as
   *  a full meter. */
  grantUsed: number;
  /** This period's monthly grant = `ai.credits.monthly(plan) * quantity`, where
   *  quantity is what `grantMonthlyForAllWallets` grants on: 1 for Community
   *  (flat, never seat-scaled — SPEC-2 §11.2), `max(quantityPaid, live orgs)`
   *  while the sub is TRIALING (#291), else `quantityPaid`. */
  grantCap: number;
  /** Whole days until the calendar-month reset `grantMonthly` anchors on. */
  grantResetsInDays: number;
  /** Never-expire purchased/pass credits (SPEC-2 §5.4 D2). */
  packBalance: number;
  /** Orgs sharing this wallet (billing group). The shared-pool note shows only
   *  when > 1 (SPEC-2 §11.1). */
  sharedOrgCount: number;
  history: CreditHistoryRow[];
  /** This org's shareable `/refer/<code>` code (SPEC-5 §2), minted on first
   *  read via `getOrCreateReferralCode` — never regenerated once set. */
  referralCode: string;
  /** How many orgs were created with this org as `referred_by_org_id`. */
  referredCount: number;
  /** Credits this wallet has earned AS A REFERRER (the +20 grants stamped
   *  `earn:referral:*` on a referred org's first paid competition) — excludes
   *  the +10 "welcome" grant a REFERRED org earns on its own wallet, which is
   *  keyed `earn:referral_welcome:*` and never sums into this org's own total. */
  referralEarned: number;
}

const HISTORY_LIMIT = 50;

/** Map a ledger row's `source` (+ sign/reason for staff adjustments) to the
 *  stable action key the UI localises. Never returns raw English: a staff
 *  `admin_adjust` is bucketed into public categories (mirrors
 *  `friendlyAdjustLabel` in credits.ts) so the internal `reason_code` stays
 *  internal. */
function actionKey(source: string, delta: number, reason: string | null): string {
  switch (source) {
    case "run_spend":
      return "run";
    case "monthly_grant":
      return "monthlyGrant";
    case "trial_grant":
      return "trialGrant";
    case "pack_purchase":
      return "pack";
    case "pass_grant":
      return "pass";
    case "earn_grant":
      return "earn";
    case "refund":
      return "refund";
    case "expiry":
      return "expiry";
    // #285: credits that moved because the org joined (or left behind) a
    // billing group — `mergeWalletOnAttach` writes this source on BOTH
    // wallets, so the label has to read true for a +delta arriving and a
    // −delta leaving. Without its own case it fell through to `adminAdjust`
    // and a wallet merge was shown to the org as a staff adjustment.
    case "group_merge":
      return "groupMerge";
    case "admin_adjust":
      if (delta < 0) return "adminAdjust";
      switch (reason) {
        case "support_goodwill":
        case "promo":
        case "bug_fix":
          return "adminGoodwill";
        case "sales_comp":
          return "adminCredit";
        case "refund_adjust":
          return "adminRefund";
        default:
          return "adminAdjust";
      }
    default:
      return "adminAdjust";
  }
}

/** Whole days from `now` until the first of next calendar month, derived from
 *  the SAME `utcMonthStart()` anchor the meter's period window is bounded by
 *  (#292) — so the days-remaining number and the window can never disagree
 *  about which month it is. */
function daysUntilMonthReset(periodStart: Date, now = new Date()): number {
  const next = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1);
  return Math.max(0, Math.ceil((next - now.getTime()) / 86_400_000));
}

/** The raw history rows for a wallet — shared by the tab view model and the CSV
 *  export route so both render the exact same ledger slice. */
export async function creditHistory(walletId: string, limit = HISTORY_LIMIT): Promise<CreditHistoryRow[]> {
  const rows = await sql<
    {
      created_at: string;
      source: string;
      delta: number;
      reason: string | null;
      org_name: string | null;
    }[]
  >`
    select l.created_at, l.source, l.delta, l.reason, o.name as org_name
      from ai_credit_ledger l
      left join organizations o on o.id::text = l.spent_by_org_id
     where l.wallet_id = ${walletId}
     order by l.created_at desc
     limit ${limit}`;
  return rows.map((r) => ({
    dateIso: new Date(r.created_at).toISOString(),
    action: actionKey(r.source, r.delta, r.reason),
    model: null,
    delta: r.delta,
    competitionName: null,
    orgName: r.org_name,
  }));
}

/** Assemble the Credits-tab view model for `orgId`'s wallet. */
export async function getCreditsTab(orgId: string): Promise<CreditsTabView> {
  const walletId = await walletIdFor(orgId);

  const [plan] = await sql<{ plan_key: string; quantity_paid: number; status: string | null }[]>`
    select coalesce(s.plan_key, 'community') as plan_key,
           coalesce(s.quantity_paid, 1) as quantity_paid,
           s.status
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
     where o.id = ${orgId}`;
  const planKey = plan?.plan_key ?? "community";
  const quantityPaid = plan?.quantity_paid ?? 1;
  const trialing = plan?.status === "trialing";

  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  const perSeat = entitlement?.int_value ?? 0;

  const periodStart = utcMonthStart();

  const [bal, packBal, spent, history, shared, referralCode, referred, referralEarned] =
    await Promise.all([
      balance(walletId),
      packBalance(walletId),
      // Credits burned FROM the grant bucket this calendar month — the meter's
      // numerator. Derived straight from run_spend rows, NOT `grantCap −
      // grantBalance`: an org that hasn't been granted yet this period has an
      // empty grant bucket but has spent nothing, and must read 0 used, not full.
      // Bound by the shared `utcMonthStart()` anchor passed as a timestamptz
      // PARAMETER (#292) — `date_trunc('month', now())` truncated in the DB
      // session's TimeZone (Europe/London in prod), so a spend at 23:30 UTC on
      // the last of the month counted into the NEXT month's meter.
      sql<{ used: string | null }[]>`
      select coalesce(sum(-delta), 0)::text as used from ai_credit_ledger
       where wallet_id = ${walletId} and bucket = 'grant' and source = 'run_spend'
         and created_at >= ${periodStart}`,
      creditHistory(walletId),
      sql<{ n: number }[]>`
      select count(*)::int as n from organizations
       where coalesce(subscription_id, id)::text = ${walletId}
         and deleted_at is null`,
      // #267 (SPEC-5 §2): mint-on-first-read, never overwritten once set.
      getOrCreateReferralCode(orgId),
      sql<{ n: number }[]>`
      select count(*)::int as n from organizations where referred_by_org_id = ${orgId}`,
      // Credits earned AS A REFERRER only (`earn:referral:*`) — the referred
      // org's own +10 welcome grant is keyed `earn:referral_welcome:*` and
      // never matches this `like` pattern (see the field's doc comment).
      sql<{ n: string | null }[]>`
      select coalesce(sum(delta), 0)::text as n from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'earn_grant'
         and idempotency_key like 'earn:referral:%'`,
    ]);

  const sharedOrgCount = Math.max(1, shared[0]?.n ?? 1);
  // The cap must be what `grantMonthlyForAllWallets` ACTUALLY granted, not an
  // independent formula: Community is flat (never seat-scaled — SPEC-2 §11.2),
  // and a TRIALING paid wallet grants on max(quantity_paid, live orgs) because
  // syncGroupQuantity freezes quantity_paid for the trial's duration (#291 —
  // see that function's docstring for the full rule). Reading the frozen count
  // alone showed a trialing group with a mid-trial rider "70 used / 60".
  const grantCap =
    perSeat *
    (planKey === "community" ? 1 : trialing ? Math.max(quantityPaid, sharedOrgCount) : quantityPaid);
  const grantUsed = Math.max(0, Math.min(grantCap, Number(spent[0]?.used ?? 0)));

  return {
    balance: bal,
    grantUsed,
    grantCap,
    grantResetsInDays: daysUntilMonthReset(periodStart),
    packBalance: packBal,
    sharedOrgCount,
    history,
    referralCode,
    referredCount: referred[0]?.n ?? 0,
    referralEarned: Number(referralEarned[0]?.n ?? 0),
  };
}

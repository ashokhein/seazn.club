import "server-only";
import { sql } from "@/lib/db";
import { balance, packBalance, walletIdFor } from "@/lib/credits";

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
  /** This period's monthly grant = `ai.credits.monthly(plan) * quantityPaid`
   *  (Community is flat, never seat-scaled — SPEC-2 §11.2). */
  grantCap: number;
  /** Whole days until the calendar-month reset `grantMonthly` anchors on. */
  grantResetsInDays: number;
  /** Never-expire purchased/pass credits (SPEC-2 §5.4 D2). */
  packBalance: number;
  /** Orgs sharing this wallet (billing group). The shared-pool note shows only
   *  when > 1 (SPEC-2 §11.1). */
  sharedOrgCount: number;
  history: CreditHistoryRow[];
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

/** Whole days from now until the first of next calendar month (UTC, matching
 *  `credits.ts`'s `monthlyPeriod()` which slices `toISOString()`). */
function daysUntilMonthReset(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
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

  const [plan] = await sql<{ plan_key: string; quantity_paid: number }[]>`
    select coalesce(s.plan_key, 'community') as plan_key,
           coalesce(s.quantity_paid, 1) as quantity_paid
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
     where o.id = ${orgId}`;
  const planKey = plan?.plan_key ?? "community";
  const quantityPaid = plan?.quantity_paid ?? 1;

  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  // Community is flat (never seat-scaled — SPEC-2 §11.2); everyone else scales
  // the per-seat grant by the group's paid seats, matching grantMonthly().
  const perSeat = entitlement?.int_value ?? 0;
  const grantCap = perSeat * (planKey === "community" ? 1 : quantityPaid);

  const [bal, packBal, spent, history, shared] = await Promise.all([
    balance(walletId),
    packBalance(walletId),
    // Credits burned FROM the grant bucket this calendar month — the meter's
    // numerator. Derived straight from run_spend rows, NOT `grantCap −
    // grantBalance`: an org that hasn't been granted yet this period has an
    // empty grant bucket but has spent nothing, and must read 0 used, not full.
    sql<{ used: string | null }[]>`
      select coalesce(sum(-delta), 0)::text as used from ai_credit_ledger
       where wallet_id = ${walletId} and bucket = 'grant' and source = 'run_spend'
         and created_at >= date_trunc('month', now())`,
    creditHistory(walletId),
    sql<{ n: number }[]>`
      select count(*)::int as n from organizations
       where coalesce(subscription_id, id)::text = ${walletId}
         and deleted_at is null`,
  ]);

  const grantUsed = Math.max(0, Math.min(grantCap, Number(spent[0]?.used ?? 0)));

  return {
    balance: bal,
    grantUsed,
    grantCap,
    grantResetsInDays: daysUntilMonthReset(),
    packBalance: packBal,
    sharedOrgCount: Math.max(1, shared[0]?.n ?? 1),
    history,
  };
}

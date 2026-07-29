import "server-only";
import { sql } from "@/lib/db";
import { balance, packBalance, utcMonthStart, walletIdFor } from "@/lib/credits";
import { orgPlanKey } from "@/lib/entitlements";
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
  /** Grant credits consumed this period = this month's grant-bucket `run_spend`
   *  NET of the refunds released against those holds (#319), clamped to
   *  [0, grantCap]. NOT `grantCap − grantBalance`: a never-granted org has
   *  grantBalance 0 yet has used nothing, which that formula would misreport as
   *  a full meter. */
  grantUsed: number;
  /** This period's monthly grant = `ai.credits.monthly(plan) * quantity`, both
   *  factors taken from `grantMonthlyForAllWallets`'s own rule so the tab can
   *  never quote a cap the sweep will not grant. PLAN is `orgPlanKey`'s
   *  RESOLVED answer for the group's representative org, not the raw
   *  `plan_key` (#318) — a suspended / past_due-beyond-grace / expired-comp
   *  wallet reads Community. QUANTITY is 1 for Community (flat, never
   *  seat-scaled — SPEC-2 §11.2), `max(quantityPaid, live orgs)` while the sub
   *  is TRIALING (#291), else `quantityPaid`. */
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
 *  about which month it is. Both args come from ONE clock sample in the
 *  caller: sampling `now` here independently would, for a request straddling
 *  UTC midnight on the 1st, measure to a boundary that had already passed and
 *  report 0 days left instead of a full fresh month. */
function daysUntilMonthReset(periodStart: Date, now: Date): number {
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

  const [plan] = await sql<{ quantity_paid: number; status: string | null; rep_org_id: string }[]>`
    select coalesce(s.quantity_paid, 1) as quantity_paid,
           s.status,
           coalesce(rep.id, o.id) as rep_org_id
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
      left join lateral (
        select r.id from organizations r
         where r.subscription_id = s.id and r.deleted_at is null
         order by (r.status = 'suspended'), r.created_at
         limit 1
      ) rep on true
     where o.id = ${orgId}`;
  const quantityPaid = plan?.quantity_paid ?? 1;
  const trialing = plan?.status === "trialing";
  // #318: the PLAN the sweep will actually grant on, not the raw `s.plan_key`.
  // `orgPlanKey` degrades a suspended / past_due-beyond-grace / expired-comp /
  // cancelled wallet to Community, so reading the raw column told a wallet
  // that had just been granted 10 that its cap was 60.
  //
  // Resolved on the group's REPRESENTATIVE org — the `rep` lateral above is
  // `grantMonthlyForAllWallets`'s own, verbatim (oldest live org, a suspended
  // one only if every member is suspended), and carries the same hand-sync
  // obligation as that copy and `groupOrgLimit`'s. Resolving on the VIEWING
  // org instead would be wrong in the opposite direction: moderation
  // suspension is deliberately scoped to one org, so a suspended member
  // would read a Community cap for a pool its siblings still fund at Pro.
  // For an ungrouped org the lateral finds nothing and `coalesce` falls back
  // to the org itself, which is also the org that answers for its own wallet.
  const planKey = await orgPlanKey(plan?.rep_org_id ?? orgId);

  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  const perSeat = entitlement?.int_value ?? 0;

  // ONE clock sample for every month-derived number on this view (see
  // daysUntilMonthReset) — never two independent `new Date()`s.
  const now = new Date();
  const periodStart = utcMonthStart(now);

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
      //
      // NET of refunds (#319), by the SAME ref-correlated subquery
      // `spentThisPeriodByOrg` (credits.ts) nets the operator allocation cap
      // with: a failed run's `release()` writes a `source='refund'` row with
      // `ref = hold.id` and no `spent_by_org_id`, so the only way to see it is
      // to net each hold by the refund rows pointing AT it. Summing gross
      // `run_spend` left a released run reading as "used this month" for the
      // rest of the month while the cap had already given it back — one
      // quantity, two derives, three lines apart, disagreeing. A pack refund
      // also uses `source='refund'` but its `ref` is a payment-intent id and
      // can never match a `run_spend` row id, so it cannot leak in here.
      sql<{ used: string | null }[]>`
      select coalesce(sum(
        -h.delta - coalesce((
          select sum(r.delta) from ai_credit_ledger r
           where r.source = 'refund' and r.ref = h.id::text
        ), 0)
      ), 0)::text as used
        from ai_credit_ledger h
       where h.wallet_id = ${walletId} and h.bucket = 'grant' and h.source = 'run_spend'
         and h.created_at >= ${periodStart}`,
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
  // QUANTITY follows `grantMonthlyForAllWallets`'s rule exactly: Community is
  // flat (never seat-scaled — SPEC-2 §11.2), and a TRIALING paid wallet grants
  // on max(quantity_paid, live orgs) because syncGroupQuantity freezes
  // quantity_paid for the trial's duration (#291 — see that function's
  // docstring for the full rule). Reading the frozen count alone showed a
  // trialing group with a mid-trial rider "70 used / 60".
  //
  // PLAN follows it too, since #318: `planKey` above is `orgPlanKey`'s
  // resolved answer for the group's representative org, so both dimensions of
  // this cap are now the sweep's own — there is no derive left here that the
  // grant cron does not share.
  const grantCap =
    perSeat *
    (planKey === "community" ? 1 : trialing ? Math.max(quantityPaid, sharedOrgCount) : quantityPaid);
  const grantUsed = Math.max(0, Math.min(grantCap, Number(spent[0]?.used ?? 0)));

  return {
    balance: bal,
    grantUsed,
    grantCap,
    grantResetsInDays: daysUntilMonthReset(periodStart, now),
    packBalance: packBal,
    sharedOrgCount,
    history,
    referralCode,
    referredCount: referred[0]?.n ?? 0,
    referralEarned: Number(referralEarned[0]?.n ?? 0),
  };
}

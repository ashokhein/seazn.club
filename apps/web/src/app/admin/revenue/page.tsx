import { requireStaff, logStaffAction } from "@/lib/admin";
import Link from "@/components/ui/console-link";
import { AdminRevenue } from "@/components/admin-revenue";
import {
  aiMarginReport,
  CREDIT_LIST_PRICE_USD,
  type AiMarginReport,
  type AiPhaseUnitRow,
} from "@/server/usecases/ai-runs-admin";

export const dynamic = "force-dynamic";

/** Window the margin monitor reports on — the same trailing 30 days the
 *  expensive-run alert takes its baseline over, so the two agree. */
const MARGIN_DAYS = 30;

/** The per-org table answers "who is burning the money", and the usecase
 *  already sorts by COGS descending — so the tail is noise. Capped in the view,
 *  not in the usecase: the aggregate tiles must still count every org. The
 *  footnote below says how many are hidden rather than truncating silently. */
const ORG_ROWS = 25;

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const pct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(0)}%`);
const count = (n: number): string => n.toLocaleString("en-GB");
/** Six decimals: a per-fixture cost lives around $0.0004, and rounding to
 *  cents would render every phase as $0.00. */
const perUnit = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(6)}`);

const PHASE_LABEL: Record<AiPhaseUnitRow["phase"], string> = {
  schedule: "Schedule",
  officials: "Officials",
};

const TILE_TONE = {
  primary: "text-white",
  neutral: "text-slate-200",
  // The one thing this panel exists to catch: credits sold below the COGS they
  // bought. Same red the console already uses for its error state.
  alarm: "text-red-300",
} as const;

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: keyof typeof TILE_TONE;
}) {
  return (
    <div className="rounded-lg bg-slate-800 p-4">
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${TILE_TONE[tone]}`}>{value}</div>
    </div>
  );
}

/** Per-phase unit economics. Kept a separate table from the per-org margin on
 *  purpose: cost per unit is only meaningful WITHIN a phase. The schedule path
 *  stamps the movable subset it was asked to place, the officials path stamps
 *  every fixture in the pack, and officials cost also scales with the roster
 *  size, which is not recorded — so the noun travels with every number and no
 *  blended cross-phase figure is offered anywhere. */
function PhaseTable({ rows }: { rows: AiPhaseUnitRow[] }) {
  const missing = rows.reduce((s, r) => s + r.runs_missing_units, 0);
  const missingCost = rows.reduce((s, r) => s + r.runs_missing_cost, 0);
  const runs = rows.reduce((s, r) => s + r.runs, 0);
  return (
    <section className="rounded-lg bg-slate-800 p-4">
      <h3 className="text-sm font-semibold text-white">Cost per unit, by phase</h3>
      <p className="mt-1 text-xs text-slate-500">
        Comparable only within a phase. Schedule counts the movable fixtures it was asked to place;
        officials counts every fixture in the pack, and officials cost also scales with the roster
        size, which is not recorded.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
              {/* Absorbs the slack so the numeric columns cluster right and
                  read as one scannable block, like the org table below. */}
              <th className="w-full py-1.5 pr-3 font-medium">Phase</th>
              <th className="py-1.5 pr-3 text-right font-medium">Runs</th>
              <th className="py-1.5 pr-3 text-right font-medium">COGS</th>
              <th className="py-1.5 pr-3 text-right font-medium">Units</th>
              <th className="py-1.5 text-right font-medium">Cost per unit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.phase} className="border-t border-slate-700/60">
                <td className="py-1.5 pr-3 whitespace-nowrap text-slate-200">
                  {PHASE_LABEL[row.phase]}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                  {count(row.runs)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                  {money(row.cogs_usd)}
                </td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums text-slate-300">
                  {count(row.units)}{" "}
                  <span className="text-xs text-slate-500">{row.unit_noun}</span>
                </td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums font-medium text-white">
                  {perUnit(row.cost_per_unit_usd)}
                  {row.cost_per_unit_usd !== null && (
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      / {row.unit_noun.replace(/s$/, "")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Stated, never silently dropped. Two different gaps with two different
          consequences: a run with no size still contributes its cost to COGS
          (only the ratio loses it), whereas a run with no readable cost is
          missing from COGS entirely — which makes COGS, and the margin above
          it, a floor rather than a total. */}
      {missing > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          {count(missing)} of {count(runs)} runs recorded no size. Their cost is counted in COGS and
          left out of cost per unit.
        </p>
      )}
      {missingCost > 0 && (
        <p className="mt-1 text-xs text-amber-300/80">
          {count(missingCost)} of {count(runs)} runs recorded no readable cost, so COGS and margin
          are floors — the real spend is higher.
        </p>
      )}
    </section>
  );
}

/** Credits sold vs COGS consumed (v17 gap #295, SPEC-2 §5.3 "live margin
 *  monitor" / SPEC-3 §6). "Credits sold" is net credit spend valued at the
 *  $0.25 list rate, not what any one pack actually charged; "COGS" comes from
 *  the AI run audit trail. The two are independent aggregates (see the
 *  usecase's own docstring) — the copy below says so, rather than letting the
 *  numbers read as a reconciled per-run figure. */
function AiMarginSection({ margin }: { margin: AiMarginReport }) {
  const idle =
    margin.aggregate.credits_spent === 0 &&
    margin.aggregate.cogs_usd === 0 &&
    margin.byPhase.every((r) => r.runs === 0);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-white">AI credit margin</h2>
        <p className="mt-1 text-xs text-slate-500">
          Last {margin.days} days. Credits sold values net credit spend at the $
          {CREDIT_LIST_PRICE_USD.toFixed(2)} list price — not what any pack actually charged. COGS is
          the real model spend on the AI run audit trail. The two come from different ledgers and
          share no run id, so read this as a trend, not a reconciliation.
        </p>
      </div>

      {/* Earn-grant volume (v17 gap #296). Deliberately OUTSIDE the idle
          branch below: earn grants are farmed by signing up and publishing,
          which burns no AI credits at all — so a farming spike would be
          invisible on a day with no AI runs, which is exactly the day it is
          most likely to happen. Today's UTC count, next to the threshold the
          daily alert fires at, so staff can watch the distance close instead
          of only finding out when the email lands. */}
      <div className="rounded-lg bg-slate-800 px-4 py-3 text-sm">
        <span className="text-slate-400">Earn grants today</span>{" "}
        <span
          className={`font-semibold tabular-nums ${
            margin.earn_grants_today >= margin.earn_grant_alert_threshold
              ? "text-red-300"
              : "text-white"
          }`}
        >
          {count(margin.earn_grants_today)}
        </span>{" "}
        <span className="text-xs text-slate-500">
          of {count(margin.earn_grant_alert_threshold)} — staff alert fires at the threshold
        </span>
      </div>

      {idle ? (
        <div className="rounded-lg bg-slate-800 p-6 text-sm text-slate-400">
          No AI runs or credit spend in the last {margin.days} days. Numbers appear once organisers
          run the AI architect.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Credits sold" value={money(margin.aggregate.revenue_usd)} tone="primary" />
            <Tile label="COGS consumed" value={money(margin.aggregate.cogs_usd)} />
            <Tile
              label="Margin"
              value={pct(margin.aggregate.margin_pct)}
              tone={
                margin.aggregate.margin_pct !== null && margin.aggregate.margin_pct < 0
                  ? "alarm"
                  : "neutral"
              }
            />
            <Tile label="Credits spent" value={count(margin.aggregate.credits_spent)} />
          </div>

          <PhaseTable rows={margin.byPhase} />

          {margin.byOrg.length > 0 && (
            <section className="rounded-lg bg-slate-800 p-4">
              <h3 className="text-sm font-semibold text-white">
                By organisation
                {margin.byOrg.length > ORG_ROWS && (
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    highest COGS first — {count(ORG_ROWS)} of {count(margin.byOrg.length)} shown
                  </span>
                )}
              </h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                      <th className="py-1.5 pr-3 font-medium">Organisation</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Credits</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Credits sold</th>
                      <th className="py-1.5 pr-3 text-right font-medium">COGS</th>
                      <th className="py-1.5 text-right font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {margin.byOrg.slice(0, ORG_ROWS).map((row) => (
                      <tr key={row.org_id ?? "unknown"} className="border-t border-slate-700/60">
                        <td className="py-1.5 pr-3">
                          {row.org_id ? (
                            <Link
                              href={`/admin/orgs/${row.org_id}`}
                              className="text-purple-300 hover:text-white"
                            >
                              {row.org_name}
                            </Link>
                          ) : (
                            <span className="text-slate-400">{row.org_name}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                          {count(row.credits_spent)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                          {money(row.revenue_usd)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                          {money(row.cogs_usd)}
                        </td>
                        <td className="py-1.5 text-right font-medium tabular-nums text-white">
                          {pct(row.margin_pct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** Platform revenue report (design/v7 PROMPT-51): Stripe application fees
 *  rolled up by month and organisation. Stripe stays the ledger — the page
 *  only reads the cached usecase through /api/admin/revenue (superadmin;
 *  the layout's staff gate lets support in, the API re-checks). Also carries
 *  the AI credit margin monitor (v17 gap #295) — a separate, server-rendered
 *  section fed by its own usecase, not the Stripe-backed API route above. */
export default async function AdminRevenuePage() {
  const staff = await requireStaff();
  // Audited on page load only (not CSV downloads, not client range
  // changes); the range mirrors the route's last-12-calendar-months default.
  const now = new Date();
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  await logStaffAction(staff.id, "revenue_report_viewed", "platform", "revenue", {
    from: monthStart(-11),
    to: monthStart(1),
  });
  const margin = await aiMarginReport(MARGIN_DAYS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Revenue</h1>
        <p className="mt-1 text-xs text-slate-500">
          What the platform has earned from card entry fees — application fees read straight
          from Stripe, grouped by month and organisation. Refreshes within 5 minutes.
        </p>
      </div>
      <AdminRevenue />
      <AiMarginSection margin={margin} />
    </div>
  );
}

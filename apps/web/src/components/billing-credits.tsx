import { t, plural, type Dict, type Locale, type TKey } from "@/lib/i18n";
import type { CreditsTabView } from "@/server/usecases/credits-tab";
import { BuyCredits } from "@/components/buy-credits";
import type { Currency, CreditPackOption } from "@/lib/currency";

interface Props {
  view: CreditsTabView;
  dict: Dict;
  locale: Locale;
  /** GET route that streams the run history as CSV (session-authed, payer-safe). */
  exportHref: string;
  /** The credit-pack ladder (SPEC-6 §A4), priced in the group's locked currency. */
  packs: CreditPackOption[];
  currency: Currency;
}

function fmtDay(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/**
 * Org Billing → Credits tab (SPEC-6 §A3): the AI-credit wallet home. Pooled
 * balance, this-month grant meter, never-expire packs, an auto-topup off-state
 * placeholder (D1 is fast-follow — rendered, not wired), and the run history
 * with a CSV export.
 *
 * Reuses the billing page's card/eyebrow/meter idiom (the same `.card` +
 * purple-600 eyebrow + slate body as Usage) so it reads as one more section on
 * a single-scroll billing page, not a bolted-on surface. The history table
 * lives in a `.scroll-x` container so the page never scrolls horizontally at
 * 375px; the summary rows stack.
 */
export function BillingCredits({ view, dict, locale, exportHref, packs, currency }: Props) {
  const grantPct = view.grantCap > 0 ? Math.min((view.grantUsed / view.grantCap) * 100, 100) : 0;
  const grantLeft = Math.max(0, view.grantCap - view.grantUsed);

  return (
    <section data-credits className="card mb-6 p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
        {t(dict, "billing.credits.title")}
      </h2>

      {/* Balance */}
      <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-slate-600">{t(dict, "billing.credits.balance")}</span>
          <span className="text-2xl font-bold text-slate-800">
            {plural(dict, "billing.credits.creditsCount", view.balance, locale)}
          </span>
        </div>

        {/* This-month grant meter */}
        <div className="mt-4">
          <div className="flex flex-wrap justify-between gap-x-2 text-sm">
            <span className="text-slate-600">{t(dict, "billing.credits.grant")}</span>
            <span className="font-medium text-slate-800">
              {t(dict, "billing.credits.grantUsed", {
                used: view.grantUsed,
                cap: view.grantCap,
              })}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-purple-100">
            <div
              className={`h-1.5 rounded-full ${grantPct >= 90 ? "bg-amber-500" : "bg-purple-500"}`}
              style={{ width: `${grantPct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {plural(dict, "billing.credits.resets", view.grantResetsInDays, locale)}
            {" · "}
            {plural(dict, "billing.credits.grantLeft", grantLeft, locale)}
          </p>
        </div>

        {/* Packs */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-600">
            {t(dict, "billing.credits.packs", { count: view.packBalance })}{" "}
            <span className="text-xs text-slate-500">({t(dict, "billing.credits.packsNote")})</span>
          </p>
          <BuyCredits packs={packs} currency={currency} dict={dict} locale={locale} />
        </div>

        {/* Shared pool (grouped org only) */}
        {view.sharedOrgCount > 1 && (
          <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-600">
            {plural(dict, "billing.credits.shared", view.sharedOrgCount, locale)}
          </p>
        )}

        {/* Auto-topup — off-state placeholder (D1 fast-follow, not wired). */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-purple-100 pt-3">
          <span className="text-sm text-slate-600">
            {t(dict, "billing.credits.autoTopup")}
          </span>
          <span className="badge bg-slate-100 text-slate-500">
            {t(dict, "billing.credits.autoTopupOff")}
          </span>
          <button
            type="button"
            disabled
            className="btn btn-ghost text-xs"
            title={t(dict, "billing.credits.comingSoon")}
          >
            {t(dict, "billing.credits.autoTopupSetup")}
          </button>
        </div>
      </div>

      {/* Run history */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            {t(dict, "billing.credits.history")}
          </h3>
          {view.history.length > 0 && (
            <a href={exportHref} className="btn btn-ghost text-xs" download>
              {t(dict, "billing.credits.export")}
            </a>
          )}
        </div>

        {view.history.length === 0 ? (
          <p className="rounded-xl border border-dashed border-purple-100 px-4 py-6 text-center text-sm text-slate-500">
            {t(dict, "billing.credits.empty")}
          </p>
        ) : (
          <div className="scroll-x scroll-x-fade -mx-1 px-1">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-purple-100 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3 font-medium">{t(dict, "billing.credits.col.date")}</th>
                  <th className="py-2 pr-3 font-medium">{t(dict, "billing.credits.col.activity")}</th>
                  <th className="py-2 pr-3 font-medium">{t(dict, "billing.credits.col.model")}</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {t(dict, "billing.credits.col.change")}
                  </th>
                  <th className="py-2 font-medium">{t(dict, "billing.credits.col.details")}</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((row, i) => (
                  <tr key={i} className="border-b border-purple-50 last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      {fmtDay(row.dateIso, locale)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-700">
                      {t(dict, `billing.credits.action.${row.action}` as TKey)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      {row.model ?? "—"}
                    </td>
                    <td
                      className={`whitespace-nowrap py-2 pr-3 text-right font-medium ${
                        row.delta < 0 ? "text-slate-700" : "text-emerald-600"
                      }`}
                    >
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </td>
                    <td className="py-2 text-slate-500">
                      {row.competitionName ?? row.orgName ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

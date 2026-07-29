import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { asCurrency, formatMinor } from "@/lib/currency";
import { PASS_RUNG_NAME_KEY, passActiveLabel } from "@/lib/pass-ladder";
import { t, type Dict, type Locale } from "@/lib/i18n";
import type { PassPurchaseRow } from "@/server/usecases/billing-manage";

interface Props {
  rows: PassPurchaseRow[];
  orgSlug: string;
  locale: Locale;
  dict: Dict;
  /** True when the generic invoice section is also on the page — the note that
   *  points at it must not promise a list that isn't there (an org whose Stripe
   *  read failed still sees these rows, but no invoice list). */
  invoicesListed: boolean;
}

/**
 * Event Pass purchases (Task 14): what the org bought, named after the
 * competition it bought it for. The generic invoice list below shows the same
 * money as anonymous Stripe rows; this section is the index that says which
 * event each charge was.
 *
 * `row.ended` (v17 gap #301) has been computed correctly by `getPassPurchases`
 * (billing-manage.ts:425, via `isPassLocked`) since SPEC-4 — this is the first
 * surface to actually RENDER it. Until now every row read the same whether the
 * pass still lifted anything or not, so the one page listing what an org has
 * bought could not tell it which of those purchases had stopped working.
 *
 * Deliberately quiet — a plain named list in the same card/eyebrow/divide-y
 * idiom as Payment methods and Invoices, because a second, louder money card
 * on a billing page reads as a second charge.
 *
 * Renders nothing when the org holds no pass: an empty card would be noise on
 * every other org's billing page.
 */
export function BillingPassPurchases({ rows, orgSlug, locale, dict, invoicesListed }: Props) {
  if (rows.length === 0) return null;

  return (
    <section data-pass-purchases className="card mb-6 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-600">
        {t(dict, "billing.passes.title")}
      </h2>
      {invoicesListed && (
        <p className="mt-1 text-xs text-slate-500">{t(dict, "billing.passes.note")}</p>
      )}

      <ul className="mt-4 divide-y divide-slate-100">
        {rows.map((row) => (
          <li
            key={row.competitionId}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={routes.competition(orgSlug, row.competitionSlug)}
                  className="font-medium text-slate-800 hover:underline"
                >
                  {row.competitionName}
                </Link>
                {/* Lime for on, slate for off — the console's own vocabulary,
                    the same pair the dashboard seal uses. The active label
                    NAMES the rung (`passActiveLabel`, not a bare
                    `t(dict, "pass.entry.active")`, which is "{rung} active"
                    and would render that brace to a customer). */}
                <span
                  data-pass-status={row.ended ? "ended" : "active"}
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide ${
                    row.ended ? "bg-slate-100 text-slate-500" : "bg-lime-100 text-lime-800"
                  }`}
                >
                  {row.ended ? t(dict, "pass.entry.ended") : passActiveLabel(dict, row.passKey)}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                {/* WHICH pass, first (v17 #294). Two rungs sell at different
                    prices and the amount beside it cannot stand in for the
                    rung: it is absent for a staff grant and absent again
                    whenever the Stripe read failed — precisely the rows where
                    the reader has nothing else to identify the purchase by. */}
                <span data-pass-rung={row.passKey} className="font-medium text-slate-700">
                  {t(dict, PASS_RUNG_NAME_KEY[row.passKey])}
                </span>
                {" · "}
                {new Date(row.purchasedIso).toLocaleDateString(locale, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
                {/* Amount only when Stripe actually told us one. A pass granted
                    by staff was never charged, and a Stripe read that failed
                    must not be reported as a price. */}
                {row.amountMinor !== null && row.currency !== null && (
                  <>
                    {" · "}
                    <span className="font-medium text-slate-700">
                      {formatMinor(row.amountMinor, asCurrency(row.currency))}
                    </span>
                  </>
                )}
              </p>
            </div>
            {row.hostedInvoiceUrl && (
              <a
                href={row.hostedInvoiceUrl}
                target="_blank"
                rel="noreferrer"
                // ml-auto, not just shrink-0: a long competition name wraps the
                // link onto its own line, where justify-between would strand it
                // on the LEFT and break the column the other rows read as.
                className="ml-auto shrink-0 text-xs text-purple-600 hover:underline"
              >
                {t(dict, "billing.passes.invoice")} ↗
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

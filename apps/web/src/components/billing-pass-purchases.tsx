import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { asCurrency, formatMinor } from "@/lib/currency";
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
              <Link
                href={routes.competition(orgSlug, row.competitionSlug)}
                className="font-medium text-slate-800 hover:underline"
              >
                {row.competitionName}
              </Link>
              <p className="text-xs text-slate-500">
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

import { asCurrency, formatMinor } from "@/lib/currency";
import { t, type Locale } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import type { InvoiceRow } from "@/lib/billing-manage";

function fmtDate(iso: string, locale: Locale) {
  return new Date(iso).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Stripe-hosted invoice list — view/PDF links only; we never render the
 * documents ourselves. Shared by the payer's invoice section and the
 * former-payer "past invoices" view so both look and behave identically.
 * Renders nothing when the list is empty.
 */
export function InvoiceList({
  invoices,
  heading,
  note,
  dict,
  locale,
}: {
  invoices: InvoiceRow[];
  heading: string;
  /** Optional muted line under the heading (e.g. why a former payer sees these). */
  note?: string;
  dict: Dict;
  locale: Locale;
}) {
  if (invoices.length === 0) return null;
  return (
    <section className="card mb-6 p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
        {heading}
      </h2>
      {note && <p className="mb-3 text-xs text-slate-500">{note}</p>}
      <ul className="divide-y divide-slate-100">
        {invoices.map((inv) => (
          <li
            key={inv.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-slate-600">{fmtDate(inv.createdIso, locale)}</span>
              {inv.number && <span className="hidden text-slate-400 sm:inline">{inv.number}</span>}
              <span className="font-medium text-slate-800">
                {formatMinor(inv.totalMinor, asCurrency(inv.currency))}
              </span>
              <span
                className={`badge ${
                  inv.status === "paid"
                    ? "bg-green-100 text-green-700"
                    : inv.isOpen
                      ? "bg-amber-100 text-amber-700"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {inv.status}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {inv.isOpen && inv.hostedUrl && (
                <a
                  href={inv.hostedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-amber-700 hover:underline"
                >
                  {t(dict, "billing.payNow")} ↗
                </a>
              )}
              {inv.hostedUrl && (
                <a
                  href={inv.hostedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-purple-600 hover:underline"
                >
                  {t(dict, "billing.view")} ↗
                </a>
              )}
              {inv.pdfUrl && (
                <a href={inv.pdfUrl} className="text-purple-600 hover:underline">
                  PDF
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

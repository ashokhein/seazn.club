import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { t, type Dict } from "@/lib/i18n";

export interface PassCandidate {
  id: string;
  name: string;
  slug: string;
}

/**
 * Event Pass offer on the billing page (task 19, spec D3 — entry point 2 of 4).
 *
 * It sits directly beneath the usage meter on purpose. That meter is where an
 * org learns it is at `competitions.max_active`, and a pass is the one thing
 * that moves the number: `assertActiveQuota` (and the meter's own `not exists`)
 * both exclude a passed competition from the count. The offer therefore answers
 * the question the row above it just raised.
 *
 * Named competitions, not a generic "buy a pass" button, because the pass is
 * bought FOR a competition — `routes.competitionUpgrade` needs one. Without
 * these links the billing page could only send the reader back into the console
 * to hunt for the same page.
 *
 * The caller owns the two gates that matter and neither is re-derived here:
 *  - community only (`isPaidPlan(orgPlanKey())`) — a paid org must never be
 *    invited to spend $29 on strictly less than it holds;
 *  - `rows` excludes competitions that already hold a pass, so nothing here can
 *    re-sell one. Held passes have their own section above
 *    (<BillingPassPurchases>), which is where "Event Pass active" is said.
 *
 * Renders nothing with no candidates: an org with no competitions has nothing
 * to buy a pass for, and an empty card would be noise.
 */
export function BillingPassOffer({
  rows,
  orgSlug,
  price,
  dict,
}: {
  rows: PassCandidate[];
  orgSlug: string;
  /** Formatted one-time price, e.g. "$29" — priced in the org's currency. */
  price: string;
  dict: Dict;
}) {
  if (rows.length === 0) return null;

  return (
    <section data-pass-offer className="card mb-6 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-600">
        {t(dict, "billing.passOffer.title")}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {t(dict, "billing.passOffer.note", { price })}
      </p>

      <ul className="mt-4 divide-y divide-slate-100">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm"
          >
            <span className="min-w-0 truncate font-medium text-slate-800" title={row.name}>
              {row.name}
            </span>
            <Link
              href={routes.competitionUpgrade(orgSlug, row.slug)}
              // ml-auto, not shrink-0 alone: a long competition name wraps the
              // link onto its own line, where justify-between strands it left.
              className="ml-auto shrink-0 text-xs font-semibold text-purple-600 hover:underline"
            >
              {t(dict, "billing.passOffer.cta", { price })} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

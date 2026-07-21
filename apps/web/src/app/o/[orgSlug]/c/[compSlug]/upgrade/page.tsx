export const dynamic = "force-dynamic";
// The Event Pass page (v3/07 §3, spec D10). One-time embedded checkout that
// upgrades THIS competition for its lifetime, reconciled on return like the
// billing page (webhook optional).
//
// It was built for one visitor — a community owner who had not bought yet — and
// served four others badly. A non-owner got a price they cannot pay. A buyer who
// came back after hitting the pass's OWN ceiling got the same "you're all set"
// green box as one who came to admire the purchase, with no receipt, no next
// step and nothing to click but "back". And an org on a paid plan was shown
// "You're on Pro" and nothing else, on a page whose whole job is to explain what
// their competition can do.
//
// Five states now, decided once in `upgradePageState()` and rendered here:
//
//   offer (owner)     the ticket, priced, with the buy button
//   offer (non-owner) the same ticket, no button — the price stays visible so
//                     they can take a number to whoever can spend it
//   owned             the stub flips to floodlit "active": bought-on date,
//                     receipt link, and the Pro step the dead end never offered
//   ceiling           a pass is held and something still blocked them; Pro only,
//                     with the credit line and the blocked limit picked out
//   paid_plan         NO TICKET AND NO PRICE ANYWHERE. Pro's matrix is a strict
//                     superset of the pass (10 AI runs against 20, 64 entrants
//                     against 256), so an offer here sells a DOWNGRADE — the
//                     defect f70b8e52 fixed in the paywall. The sales object is
//                     absent rather than disabled, which is the only version
//                     that cannot regress into a re-sale.
//
// Every figure in the comparison is read from `plan_entitlements` at render
// time. See lib/pass-comparison.ts for why nothing is written down.
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { reconcilePassCheckout } from "@/lib/billing";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { PassUpgradeButton } from "@/components/pass-upgrade";
import { Tip } from "@/components/ui/tip";
import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict, type Locale } from "@/lib/i18n";
import { isPaidPlan, orgPlanKey } from "@/lib/entitlements";
import { planLabel } from "@/lib/plan-label";
import { getPassPurchases, type PassPurchaseRow } from "@/server/usecases/billing-manage";
import { upgradePageState, type UpgradePageState } from "@/lib/upgrade-page-state";
import {
  PASS_COMPARE_FEATURES,
  PASS_COMPARE_ROWS,
  compareCell,
  rowCovers,
  type CompareCell,
  type MatrixCell,
} from "@/lib/pass-comparison";
import { withinCreditWindow } from "@/server/usecases/pass-credit";

/** `plan_key → feature_key → cell` for the plans a given state compares. */
type Matrix = Map<string, Map<string, NonNullable<MatrixCell>>>;

async function readMatrix(planKeys: string[]): Promise<Matrix> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key in ${sql(planKeys)} and feature_key in ${sql(PASS_COMPARE_FEATURES)}`;
  const matrix: Matrix = new Map(planKeys.map((k) => [k, new Map()]));
  for (const r of rows)
    matrix.get(r.plan_key)?.set(r.feature_key, { bool: r.bool_value, int: r.int_value });
  return matrix;
}

export default async function CompetitionUpgradePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<{ checkout?: string; session_id?: string; feature?: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/upgrade" });
  const orgId = page.org.id;
  const compId = page.competition.id;

  // Reconcile straight from Stripe on return from checkout (best-effort,
  // idempotent) — the pass must lift gates before any webhook lands, and this
  // read decides which of the five states the buyer lands in.
  const sp = await searchParams;
  if (sp.checkout === "success" && sp.session_id) {
    await reconcilePassCheckout(orgId, sp.session_id);
  }

  const [[pass], planKey, currency, locale] = await Promise.all([
    // Presence is ROW EXISTENCE. `stripe_payment_intent` is nullable (V271) and
    // a staff-granted pass is fully active; it is selected only to tell a
    // PURCHASE from a GRANT further down, where the difference decides whether
    // a receipt and a credit can be promised at all.
    sql<{ purchased_at: Date | string; stripe_payment_intent: string | null }[]>`
      select purchased_at, stripe_payment_intent
      from competition_passes where competition_id = ${compId}`,
    // The resolver's derivation, NOT `subscriptions.plan_key` raw — see
    // lib/upgrade-page-state.ts. NOTE the known divergence this introduces:
    // api/billing/pass-checkout/route.ts:36 still tests the raw column, so a
    // lapsed comp (or a past_due org beyond its 14-day grace) is now correctly
    // OFFERED a pass here and would be refused by that route. Converging them
    // is a billing behaviour change and deliberately out of this task's scope.
    orgPlanKey(orgId),
    preferredCurrency(orgId),
    resolveLocale(),
  ]);
  const dict = await getDictionary(locale, "ui");

  const paidPlan = isPaidPlan(planKey);
  const state = upgradePageState({
    paidPlan,
    hasPass: !!pass,
    isOwner: page.org.role === "owner",
    feature: sp.feature ?? null,
  });

  // A paid org is compared against ITS OWN plan, never against a pass column —
  // rendering the $29 column for a Pro reader is the soft version of the same
  // downgrade sale.
  const columns: string[] = paidPlan ? ["community", planKey] : ["community", "event_pass", "pro"];
  const [matrix, purchases] = await Promise.all([
    readMatrix(columns),
    // Only fetched where a receipt is rendered: one Stripe call per pass the ORG
    // holds, and no state but these two shows one.
    state.kind === "owned" || state.kind === "ceiling"
      ? getPassPurchases(orgId)
      : Promise.resolve<PassPurchaseRow[]>([]),
  ]);
  const receipt = purchases.find((p) => p.competitionId === compId) ?? null;

  const purchasedAt = pass ? new Date(pass.purchased_at) : null;
  // Every qualifier the credit line makes is checked here rather than hedged in
  // the copy: `server/usecases/pass-credit.ts` gives a staff grant no credit at
  // all (`unpaid_pass`, null intent) and nothing outside the window
  // (`outside_window`, inclusive at 30 days). Saying it anyway would be a
  // promise the checkout will not keep.
  const creditEligible =
    !!pass?.stripe_payment_intent && !!purchasedAt && withinCreditWindow(purchasedAt);

  const ceilingFeature = state.kind === "ceiling" ? state.feature : null;
  const title =
    state.kind === "paid_plan"
      ? t(dict, "upgrade.titlePlan", { name: page.competition.name })
      : pass
        ? t(dict, "upgrade.titleOwned", { name: page.competition.name })
        : t(dict, "upgrade.title", { name: page.competition.name });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="page-title">{title}</h1>

      {state.kind === "paid_plan" ? (
        <PlanPanel
          dict={dict}
          planKey={planKey}
          orgSlug={orgSlug}
          orgName={page.org.name}
          holdsPass={!!pass}
        />
      ) : (
        <Ticket
          dict={dict}
          locale={locale}
          state={state}
          currency={currency}
          competitionId={compId}
          competitionName={page.competition.name}
          orgName={page.org.name}
          receipt={receipt}
          purchasedAt={purchasedAt}
          granted={!!pass && !pass.stripe_payment_intent}
        />
      )}

      <Comparison
        dict={dict}
        columns={columns}
        matrix={matrix}
        highlight={paidPlan ? null : "event_pass"}
        ceilingFeature={ceilingFeature}
      />

      {state.kind === "offer" && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
          {t(dict, "upgrade.slotNote")}
          <Tip id="billing.event-pass" small />
        </p>
      )}

      {state.kind !== "paid_plan" && (
        <ProNext
          dict={dict}
          state={state}
          currency={currency}
          orgSlug={orgSlug}
          orgName={page.org.name}
          creditEligible={creditEligible}
        />
      )}

      <p className="mt-8">
        <Link
          href={routes.competition(orgSlug, compSlug)}
          className="text-sm font-medium text-purple-700 hover:underline"
        >
          ← {t(dict, "upgrade.backToCompetition")}
        </Link>
      </p>
    </main>
  );
}

/**
 * The ticket. The page's one bold object, and the only place state is signalled:
 * the STUB carries it, which is where a real ticket carries whether it has been
 * used. Unsold it prints a price; held it goes floodlit — night, lime tick,
 * condensed caps — because that is already this console's vocabulary for "this
 * is on" (globals.css `.app-eyebrow`, the LIVE fixture treatment task 17 and
 * task 19 both used for the pass). The green box it replaces belonged to no
 * palette in this product.
 */
function Ticket({
  dict,
  locale,
  state,
  currency,
  competitionId,
  competitionName,
  orgName,
  receipt,
  purchasedAt,
  granted,
}: {
  dict: Dict;
  locale: Locale;
  state: Exclude<UpgradePageState, { kind: "paid_plan" }>;
  currency: Currency;
  competitionId: string;
  competitionName: string;
  orgName: string;
  receipt: PassPurchaseRow | null;
  purchasedAt: Date | null;
  granted: boolean;
}) {
  const held = state.kind === "owned" || state.kind === "ceiling";
  const price = formatMinor(passPrice(currency), currency);

  return (
    <section
      className="pass-ticket mt-6 flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(21,11,54,0.06),0_18px_40px_-24px_rgba(21,11,54,0.45)] sm:flex-row"
      data-pass-ticket
    >
      <div className="flex-1 p-6 sm:p-8">
        <p className="app-eyebrow">{t(dict, "upgrade.eventPass")}</p>
        <h2 className="app-display mt-3 text-2xl font-bold text-slate-900 sm:text-3xl">
          {competitionName}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{orgName}</p>

        {state.kind === "ceiling" ? (
          <>
            <p className="mt-5 text-sm font-semibold text-slate-900">
              {t(dict, "upgrade.ceiling.title")}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {t(
                dict,
                state.liftable ? "upgrade.ceiling.included" : "upgrade.ceiling.notIncluded",
              )}
            </p>
          </>
        ) : (
          <p className="mt-5 text-sm text-slate-600">
            {t(dict, held ? "upgrade.active.body" : "upgrade.intro")}
          </p>
        )}
      </div>

      {/* The perforation: a dashed rule with a punched bite at each end.
          Vertical between body and stub on desktop, horizontal when the stub
          stacks underneath. See globals.css `.ticket-seam`. */}
      <div className="ticket-seam" aria-hidden />

      <div className="ticket-stub flex flex-col justify-center gap-3 p-6 text-center sm:w-56 sm:p-7">
        {held ? (
          <div data-pass-active>
            <p className="app-eyebrow justify-center">{t(dict, "upgrade.active.title")}</p>
            {purchasedAt && (
              <p className="mt-3 text-xs text-white/70">
                {t(dict, granted ? "upgrade.owned.granted" : "upgrade.owned.bought", {
                  date: purchasedAt.toLocaleDateString(locale, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })}
              </p>
            )}
            {/* The amount is deliberately NOT reprinted here. It is on the
                receipt, one click away, and a large "$29" on a stub that used
                to carry a price reads as a price — on the one page whose worst
                possible failure is selling the same pass twice. Holding that
                invariant ("no price anywhere once a pass is held") is worth
                more than a figure the buyer already knows. */}
            {/* Only ever a real Stripe-hosted invoice. A grant has none because
                nothing was charged; a Stripe read that failed has none because
                we could not look — and a dead "receipt" link is worse than the
                sentence that explains why there isn't one. */}
            {receipt?.hostedInvoiceUrl ? (
              <a
                href={receipt.hostedInvoiceUrl}
                target="_blank"
                rel="noreferrer"
                data-pass-receipt
                className="mt-3 inline-block text-xs font-semibold text-lime-300 underline underline-offset-2 hover:text-lime-200"
              >
                {t(dict, "upgrade.owned.receipt")} ↗
              </a>
            ) : (
              !granted && (
                <p className="mt-3 text-xs text-white/60">
                  {t(dict, "upgrade.owned.receiptPending")}
                </p>
              )
            )}
          </div>
        ) : (
          <>
            <p className="app-display text-4xl font-bold text-white tabular-nums">{price}</p>
            <p className="app-eyebrow justify-center text-[0.6875rem]">
              {t(dict, "upgrade.oneTime")}
            </p>
            {state.canBuy ? (
              <div className="mt-1">
                {/* The stub already prints the price twice its size; a button
                    repeating it is the accessory to take off. It says what
                    happens when it is pressed, and nothing else. */}
                <PassUpgradeButton competitionId={competitionId} label={t(dict, "upgrade.buyCta")} />
              </div>
            ) : (
              <p className="mt-1 text-xs text-white/70">{t(dict, "upgrade.ownerOnly")}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The already-Pro panel. Deliberately NOT a ticket: no price, no buy button, no
 * `$29` anywhere in the subtree. A Pro reader is told what their plan already
 * does for this competition and where to manage it, and — if the competition
 * happens to hold a pass from before the upgrade — that the pass is still
 * theirs, because it survives a downgrade (U15) and a silent page would read as
 * if the $29 had been absorbed.
 */
function PlanPanel({
  dict,
  planKey,
  orgSlug,
  orgName,
  holdsPass,
}: {
  dict: Dict;
  planKey: string;
  orgSlug: string;
  orgName: string;
  holdsPass: boolean;
}) {
  return (
    <section
      data-plan-covered
      className="mt-6 overflow-hidden rounded-2xl bg-[linear-gradient(135deg,var(--mk-night),var(--mk-night-2))] p-6 text-cream shadow-[0_18px_40px_-24px_rgba(21,11,54,0.45)] sm:p-8"
    >
      <p className="app-eyebrow !text-cream">{t(dict, "upgrade.pro.title")}</p>
      <h2 className="app-display mt-3 text-2xl font-bold sm:text-3xl">{planLabel(planKey)}</h2>
      <p className="mt-3 max-w-xl text-sm text-white/75">
        {t(dict, "upgrade.pro.body", { org: orgName })}
      </p>
      {holdsPass && (
        <p data-pass-dormant className="mt-3 max-w-xl text-sm text-white/60">
          {t(dict, "upgrade.pro.dormantPass")}
        </p>
      )}
      <Link
        href={routes.billing(orgSlug)}
        className="btn btn-ghost mt-5 inline-block border-white/25 bg-white/10 px-5 py-2.5 text-cream hover:bg-white/20"
      >
        {t(dict, "upgrade.pro.billingCta")} →
      </Link>
    </section>
  );
}

/**
 * What actually changes, in figures, for the competition in the URL.
 *
 * A table because the content genuinely is a grid — three plans against nine
 * limits — and a reader deciding between them compares down a column. The
 * figures are `tabular-nums` so they line up like a scoreboard rather than
 * drifting by digit width.
 */
function Comparison({
  dict,
  columns,
  matrix,
  highlight,
  ceilingFeature,
}: {
  dict: Dict;
  columns: string[];
  matrix: Matrix;
  /** Plan column to emphasise, or null when nothing is being sold. */
  highlight: string | null;
  ceilingFeature: string | null;
}) {
  const heading = (planKey: string) =>
    planKey === "community"
      ? t(dict, "upgrade.compare.free")
      : planKey === "event_pass"
        ? t(dict, "upgrade.compare.pass")
        : planLabel(planKey);

  return (
    <section className="mt-8">
      <h2 className="app-eyebrow">{t(dict, "upgrade.compare.title")}</h2>
      {/* Wide content scrolls inside its own container; the page body never
          scrolls sideways (v3/02 pattern 4).

          Focusable and named, because at 375 px this container really does
          overflow and its only content is a table — nothing inside it can take
          focus, so a keyboard user had no way to scroll it and axe flagged
          `scrollable-region-focusable` (serious) on the mobile audit added in
          task 22. `role="region"` + the section's own heading text is what
          turns the tab stop into something a screen reader can announce. */}
      <div
        className="mt-3 overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={t(dict, "upgrade.compare.title")}
      >
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-purple-100">
              <th scope="col" className="py-2 pr-3 text-left font-normal text-slate-500">
                <span className="sr-only">{t(dict, "upgrade.compare.rowHeader")}</span>
              </th>
              {columns.map((planKey) => (
                <th
                  key={planKey}
                  scope="col"
                  className={`w-20 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider sm:w-24 ${
                    planKey === highlight ? "text-purple-700" : "text-slate-400"
                  }`}
                >
                  {heading(planKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PASS_COMPARE_ROWS.map((row) => {
              const isCeiling = rowCovers(row, ceilingFeature);
              return (
                <tr
                  key={row.labelKey}
                  data-ceiling-row={isCeiling || undefined}
                  className={`border-b border-slate-100 last:border-0 ${
                    isCeiling ? "bg-lime-50/70" : ""
                  }`}
                >
                  <th
                    scope="row"
                    className="py-2.5 pr-3 text-left text-sm font-normal text-slate-600"
                  >
                    {isCeiling && (
                      <span
                        aria-hidden
                        className="mr-2 inline-block h-3 w-1 rounded-full align-middle bg-lime-400"
                      />
                    )}
                    {t(dict, row.labelKey)}
                  </th>
                  {columns.map((planKey) => (
                    <td
                      key={planKey}
                      className={`px-2 py-2.5 text-center tabular-nums ${
                        planKey === highlight
                          ? "bg-purple-50/60 font-semibold text-purple-900"
                          : "text-slate-600"
                      }`}
                    >
                      <Cell
                        dict={dict}
                        cell={compareCell(row.kind, matrix.get(planKey)?.get(row.features[0]))}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr>
              <th scope="row" className="py-2.5 pr-3 text-left text-sm font-normal text-slate-600">
                {t(dict, "upgrade.compare.appliesTo")}
              </th>
              {columns.map((planKey) => (
                <td
                  key={planKey}
                  className={`px-2 py-2.5 text-center text-xs ${
                    planKey === highlight
                      ? "bg-purple-50/60 font-semibold text-purple-900"
                      : "text-slate-500"
                  }`}
                >
                  {t(
                    dict,
                    planKey === "event_pass"
                      ? "upgrade.compare.thisComp"
                      : "upgrade.compare.everyComp",
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cell({ dict, cell }: { dict: Dict; cell: CompareCell }) {
  if (cell.type === "value") return <>{cell.text}</>;
  if (cell.type === "unlimited") return <>{t(dict, "upgrade.compare.unlimited")}</>;
  if (cell.type === "yes")
    return (
      <span title={t(dict, "upgrade.compare.included")}>
        <span aria-hidden>✓</span>
        <span className="sr-only">{t(dict, "upgrade.compare.included")}</span>
      </span>
    );
  return (
    <span title={t(dict, "upgrade.compare.excluded")} className="text-slate-300">
      <span aria-hidden>—</span>
      <span className="sr-only">{t(dict, "upgrade.compare.excluded")}</span>
    </span>
  );
}

/**
 * The step after the pass. This is the half of the page the old owned state did
 * not have at all: it confirmed a purchase and offered nothing next.
 *
 * At the ceiling it is the ONLY action, because there is nothing left to buy for
 * this competition — the same shape task 17 gave the pass-owned paywall.
 *
 * The credit sentence is task 17's wording, unchanged, and it renders only when
 * `pass-credit.ts` would actually pay it out. See `creditEligible` above.
 */
function ProNext({
  dict,
  state,
  currency,
  orgSlug,
  orgName,
  creditEligible,
}: {
  dict: Dict;
  state: UpgradePageState;
  currency: Currency;
  orgSlug: string;
  orgName: string;
  creditEligible: boolean;
}) {
  const held = state.kind === "owned" || state.kind === "ceiling";
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);

  return (
    <section className={`card mt-6 p-6 ${held ? "" : "border-dashed"}`}>
      <p className="app-eyebrow">
        {t(dict, held ? "upgrade.owned.nextTitle" : "upgrade.proCard.title")}
      </p>
      <p className="mt-2 text-3xl font-bold text-slate-900 tabular-nums">
        {proMonthly}
        <span className="text-base font-normal text-slate-500">{t(dict, "upgrade.perMonth")}</span>
      </p>
      <p className="mt-3 max-w-xl text-sm text-slate-600">
        {t(dict, held ? "upgrade.owned.nextBody" : "upgrade.proCard.body", { org: orgName })}
      </p>
      <Link href={routes.billing(orgSlug)} className="btn btn-primary mt-5 inline-block px-5 py-2.5">
        {t(dict, "upgrade.proCard.cta")} →
      </Link>
      {creditEligible && (
        <p data-pass-credit className="mt-3 text-xs text-slate-500">
          {t(dict, "upgrade.credit", { plan: "Pro" })}
        </p>
      )}
    </section>
  );
}

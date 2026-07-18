export const dynamic = "force-dynamic";
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { reconcileCheckout, billingCtaLabel } from "@/lib/billing";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BillingBanner } from "@/components/billing-banner";
import { UpgradeButton, DowngradeButton } from "@/components/billing-actions";
import {
  BillingDetailsCard,
  CancelSubscriptionButton,
  PaymentMethodsManager,
  PlanIntervalSwitcher,
  PlanKeySwitcher,
  PromoCodeBox,
  ResumeSubscriptionButton,
  RetryPaymentButton,
} from "@/components/billing-manage";
import { getBillingOverview } from "@/server/usecases/billing-manage";
import { type Subscription } from "@/lib/types";
import { getLimit } from "@/lib/entitlements";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { asCurrency, formatMinor, proPrice, proPlusPrice } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, plural, type Dict, type Locale } from "@/lib/i18n";

function fmt(iso: string | null, locale: Locale) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

const STATUS_BADGE: Record<string, string> = {
  trialing: "bg-purple-100 text-purple-700",
  active: "bg-green-100 text-green-700",
  past_due: "bg-amber-100 text-amber-700",
  canceled: "bg-slate-100 text-slate-500",
  suspended: "bg-red-100 text-red-700",
};

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/billing" });
  const orgId = org.id;
  const isOwner = org.role === "owner";
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  // Reconcile straight from Stripe on return from checkout, so the plan updates
  // even if the webhook is delayed or missing (best-effort, never throws).
  const sp = await searchParams;
  const justCheckedOut = sp.checkout === "success";
  if (justCheckedOut && sp.session_id) {
    await reconcileCheckout(orgId, sp.session_id);
  }

  // Live Stripe read for the manage sections (owner only). Runs BEFORE the
  // subscription select because it also performs the lazy renewal re-sync
  // (missed webhook / past_due self-heal) that may rewrite the row.
  const overview = isOwner ? await getBillingOverview(orgId) : null;

  const [sub] = await sql<Subscription[]>`
    select * from subscriptions where org_id = ${orgId}`;

  const planKey = sub?.plan_key ?? "community";
  const status = sub?.status ?? "active";
  const isPro = planKey === "pro";
  // V290 added pro_plus above pro — isPaid recognises either paid plan (the
  // upgrade section only shows on Community); isPro/isPlus stay exact-plan.
  const isPaid = planKey === "pro" || planKey === "pro_plus";
  const isPlus = planKey === "pro_plus";
  // One trial per org (V277): the upgrade CTA must not promise a trial the
  // checkout won't grant.
  const trialAvailable = !sub?.trial_used_at;
  // A comped/dev-granted Pro org has no Stripe subscription — it gets the
  // in-app downgrade instead of the cancel-at-period-end flow.
  const hasStripeSubscription = !!sub?.stripe_subscription_id;

  // v2 usage vs plan quotas (doc 10 §1) — v1 seasons/tournaments died at the
  // PROMPT-15 cutover; overrides are honoured via getLimit.
  const [counts] = await sql<
    { competitions_active: number; dashboards_public: number; members: number }[]
  >`
    select
      (select count(*)::int from competitions
        where org_id = ${orgId} and status in ('draft','published','live'))
        as competitions_active,
      (select count(*)::int from competitions
        where org_id = ${orgId} and visibility = 'public') as dashboards_public,
      (select count(*)::int from org_members m
        where m.org_id = ${orgId} and m.role != 'scorer') as members`;
  const [competitionsLimit, dashboardsLimit, membersLimit] = await Promise.all([
    getLimit(orgId, "competitions.max_active"),
    getLimit(orgId, "dashboard.public.max"),
    getLimit(orgId, "members.max"),
  ]);

  const trialDays = daysUntil(sub?.trial_end ?? null);
  const currency = await preferredCurrency(orgId);

  return (
    <>
      <TrackOnMount
        event={EVENTS.BILLING_VIEWED}
        properties={{ plan_key: sub?.plan_key ?? "community" }}
      />
      {orgId && <BillingBanner orgId={orgId} />}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="page-title">
            {t(dict, "billing.title")}
          </h1>
          <Link href={routes.orgSettings(orgSlug)} className="btn btn-ghost">
            ← {t(dict, "action.settings")}
          </Link>
        </div>

        {justCheckedOut && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {t(dict, "billing.checkoutComplete")} <span className="font-semibold capitalize">{planKey}</span>
            {status === "trialing" ? t(dict, "billing.trialSuffix") : ""}.
          </div>
        )}

        {/* Current plan */}
        <section data-tour="billing-plan" className="card mb-6 p-5">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
            {t(dict, "billing.currentPlan")}
          </h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-slate-800 capitalize">
                  {planKey}
                </span>
                <span className={`badge ${STATUS_BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
                  {t(dict, `billing.status.${status}`)}
                </span>
              </div>

              {status === "trialing" && trialDays !== null && (
                <p className="mt-1 text-sm text-purple-600">
                  {trialDays > 0
                    ? plural(dict, "billing.trialRemaining", trialDays, locale)
                    : t(dict, "billing.trialEnded")}
                </p>
              )}
              {sub?.current_period_end && status === "active" && (
                <p className="mt-1 text-sm text-slate-500">
                  {sub.cancel_at_period_end
                    ? t(dict, "billing.proUntil", { date: fmt(sub.current_period_end, locale) ?? "" })
                    : `${t(dict, "billing.renews", { date: fmt(sub.current_period_end, locale) ?? "" })}${
                        overview?.interval
                          ? ` · ${overview.interval === "annual" ? t(dict, "billing.billedYearly") : t(dict, "billing.billedMonthly")}`
                          : ""
                      }`}
                </p>
              )}
              {overview && overview.creditMinor > 0 && (
                <p className="mt-1 text-sm text-emerald-600">
                  {t(dict, "billing.credit", {
                    amount: formatMinor(overview.creditMinor, asCurrency(overview.currency)),
                  })}
                </p>
              )}
            </div>

            {isOwner &&
              isPaid &&
              status === "trialing" &&
              ((overview?.paymentMethods.length ?? 0) === 0 ? (
                <a href="#payment-methods" className="btn btn-primary">
                  {billingCtaLabel(status)}
                </a>
              ) : (
                <p className="text-sm text-emerald-600">
                  {t(dict, "billing.cardOnFile")}
                </p>
              ))}
            {isOwner && isPaid && !hasStripeSubscription && <DowngradeButton />}
          </div>

          {/* In-app plan management (v3/11) — no Stripe portal. */}
          {isOwner && isPaid && hasStripeSubscription && (
            <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4">
              {status === "past_due" && overview?.hasOpenInvoice && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3">
                  <p className="text-sm text-amber-800">
                    {t(dict, "billing.paymentFailed")}
                  </p>
                  <RetryPaymentButton />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {overview?.interval && !sub?.cancel_at_period_end && status !== "past_due" && (
                  <PlanIntervalSwitcher current={overview.interval} />
                )}
                {sub?.cancel_at_period_end ? (
                  <ResumeSubscriptionButton />
                ) : (
                  status !== "past_due" && (
                    <CancelSubscriptionButton periodEnd={sub?.current_period_end ?? null} />
                  )
                )}
              </div>
              {overview && <PromoCodeBox discount={overview.discount} />}
              {/* Live-sub plan change (Task 7): Pro -> Pro Plus upsell here;
                  Pro Plus already has the ceiling, so it only gets the
                  priority-support perk below. */}
              {isPro && overview?.interval && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
                  <p className="text-sm font-semibold text-indigo-800">
                    {t(dict, "billing.cta.goPlus")}
                  </p>
                  <p className="mt-1 text-xs text-indigo-700">{t(dict, "billing.plus.f5")}</p>
                  <div className="mt-2">
                    <PlanKeySwitcher currentPlanKey="pro" interval={overview.interval} />
                  </div>
                </div>
              )}
              {isPlus && (
                <a
                  href="mailto:plus@seazn.club"
                  className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 hover:underline"
                >
                  {t(dict, "billing.plusSupport")}
                </a>
              )}
            </div>
          )}
        </section>

        {/* Payment methods — card entry stays in Stripe's iframe (SAQ A). */}
        {isOwner && overview && (
          <section id="payment-methods" className="card mb-6 p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              {t(dict, "billing.paymentMethods")}
            </h2>
            <PaymentMethodsManager
              methods={overview.paymentMethods}
              autoOpen={status === "trialing" && overview.paymentMethods.length === 0}
            />
          </section>
        )}

        {/* Billing details — address drives automatic_tax; VAT/GST id prints
            on invoices and flips EU B2B to reverse charge. */}
        {isOwner && overview && (
          <section className="card mb-6 p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              {t(dict, "billing.billingDetails")}
            </h2>
            <BillingDetailsCard
              name={overview.billingName}
              address={overview.billingAddress}
              taxIds={overview.taxIds}
            />
          </section>
        )}

        {/* Invoices — Stripe-hosted view/PDF links; we never render documents. */}
        {isOwner && overview && overview.invoices.length > 0 && (
          <section className="card mb-6 p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              {t(dict, "billing.invoices")}
            </h2>
            <ul className="divide-y divide-slate-100">
              {overview.invoices.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="text-slate-600">{fmt(inv.createdIso, locale)}</span>
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
        )}

        {/* Usage */}
        <section className="card mb-6 p-5">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
            {t(dict, "billing.usage")}
          </h2>
          <div className="space-y-3">
            <UsageRow
              label={t(dict, "billing.usage.competitions")}
              current={counts?.competitions_active ?? 0}
              limit={competitionsLimit}
            />
            <UsageRow
              label={t(dict, "billing.usage.dashboards")}
              current={counts?.dashboards_public ?? 0}
              limit={dashboardsLimit}
            />
            <UsageRow
              label={t(dict, "billing.usage.members")}
              current={counts?.members ?? 0}
              limit={membersLimit}
              note={t(dict, "billing.usage.scorerNote")}
            />
          </div>
        </section>

        {/* Upgrade / plan comparison */}
        {!isPaid && isOwner && (
          <section className="card p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              {t(dict, "billing.upgradeToPro")}
            </h2>
            {/* Stacks under `xs` — two 160px columns don't fit a 375px phone. */}
            <div className="mb-5 grid gap-3 text-sm xs:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-1 font-semibold text-slate-700">Community</p>
                <p className="text-2xl font-bold text-slate-800">
                  {t(dict, "billing.plan.free")}
                </p>
                <ul className="mt-3 space-y-1 text-slate-500">
                  <li>✓ {t(dict, "billing.community.f1")}</li>
                  <li>✓ {t(dict, "billing.community.f2")}</li>
                  <li>✓ {t(dict, "billing.community.f3")}</li>
                  <li>✓ {t(dict, "billing.community.f4")}</li>
                  <li className="text-slate-300">✗ {t(dict, "billing.community.f5")}</li>
                  <li className="text-slate-300">✗ {t(dict, "billing.community.f6")}</li>
                  <li className="text-slate-300">✗ {t(dict, "billing.community.f7")}</li>
                </ul>
              </div>
              <div className="rounded-xl border-2 border-purple-500 bg-purple-50 p-4">
                <p className="mb-1 font-semibold text-purple-700">Pro</p>
                <p className="text-2xl font-bold text-slate-800">
                  {formatMinor(proPrice("monthly", currency), currency)}
                  <span className="text-base font-normal text-slate-500">{t(dict, "billing.perMo")}</span>
                </p>
                <ul className="mt-3 space-y-1 text-slate-700">
                  <li>✓ {t(dict, "billing.pro.f1")}</li>
                  <li>✓ {t(dict, "billing.pro.f2")}</li>
                  <li>✓ {t(dict, "billing.pro.f3")}</li>
                  <li>✓ {t(dict, "billing.pro.f4")}</li>
                  <li>✓ {t(dict, "billing.pro.f5")}</li>
                  <li>✓ {t(dict, "billing.pro.f6")}</li>
                  <li>✓ {t(dict, "billing.pro.f7")}</li>
                </ul>
              </div>
              <div className="rounded-xl border-2 border-indigo-500 bg-indigo-50 p-4">
                <p className="mb-1 font-semibold text-indigo-700">Pro Plus</p>
                <p className="text-2xl font-bold text-slate-800">
                  {formatMinor(proPlusPrice("monthly", currency), currency)}
                  <span className="text-base font-normal text-slate-500">{t(dict, "billing.perMo")}</span>
                </p>
                <ul className="mt-3 space-y-1 text-slate-700">
                  <li>✓ {t(dict, "billing.plus.f1")}</li>
                  <li>✓ {t(dict, "billing.plus.f2")}</li>
                  <li>✓ {t(dict, "billing.plus.f3")}</li>
                  <li>✓ {t(dict, "billing.plus.f4")}</li>
                  <li>✓ {t(dict, "billing.plus.f5")}</li>
                </ul>
              </div>
            </div>
            <p className="mb-4 text-xs text-slate-500">
              {trialAvailable
                ? t(dict, "billing.trialCopy.available")
                : t(dict, "billing.trialCopy.used")}
            </p>
            {/* Annual leads (v3/07 §4): 12 for the price of 10, said plainly. */}
            <div className="flex flex-wrap items-center gap-3">
              <UpgradeButton
                interval="annual"
                label={`${trialAvailable ? t(dict, "billing.cta.startTrial") : t(dict, "billing.cta.goPro")} — ${formatMinor(
                  Math.round(proPrice("annual", currency) / 12),
                  currency,
                )}${t(dict, "billing.perMoBilledYearly")}`}
              />
              <UpgradeButton
                interval="monthly"
                label={t(dict, "billing.orMonthly", {
                  price: formatMinor(proPrice("monthly", currency), currency),
                })}
                ghost
              />
            </div>
            <p className="mt-2 text-xs text-emerald-600">
              {t(dict, "billing.annualSaves")}
            </p>
            {/* Pro Plus goes straight to checkout too — no separate compare
                page; the card above already states what it adds over Pro. */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              <UpgradeButton
                plan="pro_plus"
                interval="annual"
                label={`${t(dict, "billing.cta.goPlus")} — ${formatMinor(
                  Math.round(proPlusPrice("annual", currency) / 12),
                  currency,
                )}${t(dict, "billing.perMoBilledYearly")}`}
              />
              <UpgradeButton
                plan="pro_plus"
                interval="monthly"
                label={t(dict, "billing.orMonthly", {
                  price: formatMinor(proPlusPrice("monthly", currency), currency),
                })}
                ghost
              />
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function UsageRow({
  label,
  current,
  limit,
  note,
}: {
  label: string;
  current: number | null;
  limit: number | null;
  note?: string;
}) {
  const unlimited = limit === null;
  const pct = unlimited || current === null ? null : Math.min((current / limit) * 100, 100);

  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-600">
          {label}
          {note && <span className="ml-1 text-xs text-slate-500">({note})</span>}
        </span>
        <span className="font-medium text-slate-800">
          {current !== null ? `${current} / ` : ""}
          {unlimited ? "∞" : limit}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
          <div
            className={`h-1.5 rounded-full ${pct >= 90 ? "bg-amber-500" : "bg-purple-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

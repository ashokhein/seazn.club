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
  PromoCodeBox,
  ResumeSubscriptionButton,
  RetryPaymentButton,
} from "@/components/billing-manage";
import { getBillingOverview } from "@/server/usecases/billing-manage";
import { type Subscription } from "@/lib/types";
import { getLimit } from "@/lib/entitlements";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { asCurrency, formatMinor, proPrice } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";

function fmt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
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
            Plan & Billing
          </h1>
          <Link href={routes.orgSettings(orgSlug)} className="btn btn-ghost">
            ← Settings
          </Link>
        </div>

        {justCheckedOut && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            Checkout complete — your plan is now <span className="font-semibold capitalize">{planKey}</span>
            {status === "trialing" ? " (trial)" : ""}.
          </div>
        )}

        {/* Current plan */}
        <section className="card mb-6 p-5">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
            Current plan
          </h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-slate-800 capitalize">
                  {planKey}
                </span>
                <span className={`badge ${STATUS_BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
                  {status.replace("_", " ")}
                </span>
              </div>

              {status === "trialing" && trialDays !== null && (
                <p className="mt-1 text-sm text-purple-600">
                  {trialDays > 0
                    ? `${trialDays} day${trialDays === 1 ? "" : "s"} remaining in trial`
                    : "Trial ended"}
                </p>
              )}
              {sub?.current_period_end && status === "active" && (
                <p className="mt-1 text-sm text-slate-500">
                  {sub.cancel_at_period_end
                    ? `Pro until ${fmt(sub.current_period_end)} — then Community`
                    : `Renews ${fmt(sub.current_period_end)}${
                        overview?.interval
                          ? ` · billed ${overview.interval === "annual" ? "yearly" : "monthly"}`
                          : ""
                      }`}
                </p>
              )}
              {overview && overview.creditMinor > 0 && (
                <p className="mt-1 text-sm text-emerald-600">
                  {formatMinor(overview.creditMinor, asCurrency(overview.currency))} account credit — pays
                  future invoices automatically.
                </p>
              )}
            </div>

            {isOwner &&
              isPro &&
              status === "trialing" &&
              ((overview?.paymentMethods.length ?? 0) === 0 ? (
                <a href="#payment-methods" className="btn btn-primary">
                  {billingCtaLabel(status)}
                </a>
              ) : (
                <p className="text-sm text-emerald-600">
                  Card on file — Pro continues after the trial.
                </p>
              ))}
            {isOwner && isPro && !hasStripeSubscription && <DowngradeButton />}
          </div>

          {/* In-app plan management (v3/11) — no Stripe portal. */}
          {isOwner && isPro && hasStripeSubscription && (
            <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4">
              {status === "past_due" && overview?.hasOpenInvoice && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3">
                  <p className="text-sm text-amber-800">
                    Your last payment failed. Fix the card below, then retry.
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
            </div>
          )}
        </section>

        {/* Payment methods — card entry stays in Stripe's iframe (SAQ A). */}
        {isOwner && overview && (
          <section id="payment-methods" className="card mb-6 p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              Payment methods
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
              Billing details
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
              Invoices
            </h2>
            <ul className="divide-y divide-slate-100">
              {overview.invoices.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="text-slate-600">{fmt(inv.createdIso)}</span>
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
                        Pay now ↗
                      </a>
                    )}
                    {inv.hostedUrl && (
                      <a
                        href={inv.hostedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-purple-600 hover:underline"
                      >
                        View ↗
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
            Usage
          </h2>
          <div className="space-y-3">
            <UsageRow
              label="Active competitions"
              current={counts?.competitions_active ?? 0}
              limit={competitionsLimit}
            />
            <UsageRow
              label="Public dashboards"
              current={counts?.dashboards_public ?? 0}
              limit={dashboardsLimit}
            />
            <UsageRow
              label="Team members"
              current={counts?.members ?? 0}
              limit={membersLimit}
              note="scorer seats not counted"
            />
          </div>
        </section>

        {/* Upgrade / plan comparison */}
        {!isPro && isOwner && (
          <section className="card p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
              Upgrade to Pro
            </h2>
            {/* Stacks under `xs` — two 160px columns don't fit a 375px phone. */}
            <div className="mb-5 grid gap-3 text-sm xs:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-1 font-semibold text-slate-700">Community</p>
                <p className="text-2xl font-bold text-slate-800">
                  Free
                </p>
                <ul className="mt-3 space-y-1 text-slate-500">
                  <li>✓ 1 active competition</li>
                  <li>✓ 2 divisions, 16 entrants each</li>
                  <li>✓ 1 public dashboard</li>
                  <li>✓ Free-event registration</li>
                  <li className="text-slate-300">✗ Entry fees (Stripe payouts)</li>
                  <li className="text-slate-300">✗ Branding & exports</li>
                  <li className="text-slate-300">✗ Realtime scoreboard</li>
                </ul>
              </div>
              <div className="rounded-xl border-2 border-purple-500 bg-purple-50 p-4">
                <p className="mb-1 font-semibold text-purple-700">Pro</p>
                <p className="text-2xl font-bold text-slate-800">
                  {formatMinor(proPrice("monthly", currency), currency)}
                  <span className="text-base font-normal text-slate-500">/mo</span>
                </p>
                <ul className="mt-3 space-y-1 text-slate-700">
                  <li>✓ Unlimited competitions & divisions</li>
                  <li>✓ 256 entrants per division</li>
                  <li>✓ Online registration + entry fees (2%)</li>
                  <li>✓ Ball-by-ball & rally scoring</li>
                  <li>✓ Custom branding</li>
                  <li>✓ CSV / PDF exports</li>
                  <li>✓ Realtime scoreboard</li>
                </ul>
              </div>
            </div>
            <p className="mb-4 text-xs text-slate-500">
              {trialAvailable
                ? "14-day free trial · no card required · cancel anytime"
                : "Billed from day one — your free trial has already been used · cancel anytime"}
            </p>
            {/* Annual leads (v3/07 §4): 12 for the price of 10, said plainly. */}
            <div className="flex flex-wrap items-center gap-3">
              <UpgradeButton
                interval="annual"
                label={`${trialAvailable ? "Start free trial" : "Go Pro"} — ${formatMinor(
                  Math.round(proPrice("annual", currency) / 12),
                  currency,
                )}/mo billed yearly`}
              />
              <UpgradeButton
                interval="monthly"
                label={`or ${formatMinor(proPrice("monthly", currency), currency)} monthly`}
                ghost
              />
            </div>
            <p className="mt-2 text-xs text-emerald-600">
              Annual saves 17% — two months free.
            </p>
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

export const dynamic = "force-dynamic";
import Link from "next/link";
import { sql } from "@/lib/db";
import { reconcileCheckout, billingCtaLabel } from "@/lib/billing";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BillingBanner } from "@/components/billing-banner";
import { UpgradeButton, ManageBillingButton, DowngradeButton } from "@/components/billing-actions";
import { type Subscription } from "@/lib/types";
import { getLimit } from "@/lib/entitlements";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { formatMinor, proPrice } from "@/lib/currency";
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

  const [sub] = await sql<Subscription[]>`
    select * from subscriptions where org_id = ${orgId}`;

  const planKey = sub?.plan_key ?? "community";
  const status = sub?.status ?? "active";
  const isPro = planKey === "pro";
  const hasStripeCustomer = !!sub?.stripe_customer_id;
  // A comped/dev-granted Pro org has no Stripe subscription — it can't use the
  // portal, so offer an in-app downgrade instead.
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
          <h1 className="text-2xl font-bold tracking-tight text-purple-900">
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
                    ? `Cancels on ${fmt(sub.current_period_end)}`
                    : `Renews ${fmt(sub.current_period_end)}`}
                </p>
              )}
            </div>

            {isOwner && isPro && hasStripeCustomer && (
              <ManageBillingButton
                label={billingCtaLabel(status)}
                primary={status === "trialing"}
              />
            )}
            {isOwner && isPro && !hasStripeSubscription && <DowngradeButton />}
          </div>
        </section>

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
              14-day free trial · no card required · cancel anytime
            </p>
            {/* Annual leads (v3/07 §4): 12 for the price of 10, said plainly. */}
            <div className="flex flex-wrap items-center gap-3">
              <UpgradeButton
                interval="annual"
                label={`Start free trial — ${formatMinor(
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

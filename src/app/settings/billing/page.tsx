export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveOrgId, getCurrentUser, requireOrgRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { reconcileCheckout } from "@/lib/billing";
import { Nav } from "@/components/nav";
import { BillingBanner } from "@/components/billing-banner";
import { UpgradeButton, ManageBillingButton } from "@/components/billing-actions";
import { ORG_ROLES, type Subscription } from "@/lib/types";

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
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orgId = await getActiveOrgId();
  if (!orgId) redirect("/orgs/new");

  const { role } = await requireOrgRole(orgId, ORG_ROLES);
  const isOwner = role === "owner";

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

  const [{ seasons_count }] = await sql<{ seasons_count: number }[]>`
    select count(*)::int as seasons_count from seasons where org_id = ${orgId}`;

  const trialDays = daysUntil(sub?.trial_end ?? null);

  return (
    <>
      <Nav />
      {orgId && <BillingBanner orgId={orgId} />}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-purple-900">
            Plan & Billing
          </h1>
          <Link href="/settings" className="btn btn-ghost">
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
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-400">
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

            {isOwner && isPro && hasStripeCustomer && <ManageBillingButton />}
          </div>
        </section>

        {/* Usage */}
        <section className="card mb-6 p-5">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-400">
            Usage
          </h2>
          <div className="space-y-3">
            <UsageRow
              label="Seasons"
              current={seasons_count}
              limit={isPro ? null : 5}
            />
            <UsageRow
              label="Tournaments per season"
              current={null}
              limit={isPro ? null : 10}
              note="counted per season"
            />
            <UsageRow
              label="Players per tournament"
              current={null}
              limit={isPro ? null : 32}
            />
          </div>
        </section>

        {/* Upgrade / plan comparison */}
        {!isPro && isOwner && (
          <section className="card p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-400">
              Upgrade to Pro
            </h2>
            <div className="mb-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-1 font-semibold text-slate-700">Community</p>
                <p className="text-2xl font-bold text-slate-800">
                  Free
                </p>
                <ul className="mt-3 space-y-1 text-slate-500">
                  <li>✓ All formats</li>
                  <li>✓ 5 seasons</li>
                  <li>✓ 10 tournaments/season</li>
                  <li>✓ 32 players/tournament</li>
                  <li className="text-slate-300">✗ Branding</li>
                  <li className="text-slate-300">✗ Exports</li>
                  <li className="text-slate-300">✗ Realtime scoreboard</li>
                </ul>
              </div>
              <div className="rounded-xl border-2 border-purple-500 bg-purple-50 p-4">
                <p className="mb-1 font-semibold text-purple-700">Pro</p>
                <p className="text-2xl font-bold text-slate-800">
                  $20
                  <span className="text-base font-normal text-slate-500">/mo</span>
                </p>
                <ul className="mt-3 space-y-1 text-slate-700">
                  <li>✓ All formats</li>
                  <li>✓ Unlimited seasons</li>
                  <li>✓ Unlimited tournaments</li>
                  <li>✓ 256 players/tournament</li>
                  <li>✓ Custom branding</li>
                  <li>✓ CSV / PDF exports</li>
                  <li>✓ Realtime scoreboard</li>
                </ul>
              </div>
            </div>
            <p className="mb-4 text-xs text-slate-400">
              14-day free trial · no card required · cancel anytime
            </p>
            <div className="flex flex-wrap gap-3">
              <UpgradeButton interval="monthly" label="Start free trial — $20/mo" />
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
          {note && <span className="ml-1 text-xs text-slate-400">({note})</span>}
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

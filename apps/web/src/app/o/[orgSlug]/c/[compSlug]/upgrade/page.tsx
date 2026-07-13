export const dynamic = "force-dynamic";
// Event Pass purchase page (v3/07 §3): one-time embedded checkout that
// upgrades THIS competition for its lifetime. Reconciles on return like the
// billing page (webhook optional).
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { reconcilePassCheckout } from "@/lib/billing";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { PassUpgradeButton } from "@/components/pass-upgrade";
import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";

const PASS_INCLUDES = [
  "10 divisions in this competition (Free: 2)",
  "32 entrants per division (Free: 16)",
  "Advanced formats — double elimination, ladders, americano",
  "Online entry fees via Stripe (5% platform fee)",
  "Custom branding, PDF/XLSX exports, realtime slideshow",
];

export default async function CompetitionUpgradePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/upgrade" });
  const orgId = page.org.id;
  const compId = page.competition.id;

  // Reconcile straight from Stripe on return from checkout (best-effort,
  // idempotent) — the pass must lift gates before any webhook lands.
  const sp = await searchParams;
  if (sp.checkout === "success" && sp.session_id) {
    await reconcilePassCheckout(orgId, sp.session_id);
  }

  const [[pass], [sub]] = await Promise.all([
    sql<{ purchased_at: string }[]>`
      select purchased_at from competition_passes where competition_id = ${compId}`,
    sql<{ plan_key: string | null }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`,
  ]);
  const isPro = !!sub?.plan_key && sub.plan_key !== "community";
  const currency: Currency = await preferredCurrency(orgId);
  const isOwner = page.org.role === "owner";

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">
        Upgrade “{page.competition.name}”
      </h1>

      {pass ? (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900" data-pass-active>
          <p className="font-semibold">Event Pass active ✓</p>
          <p className="mt-1">
            This competition is upgraded for its lifetime — divisions, entrants,
            formats, fees, branding and exports are all unlocked here.
          </p>
          <Link
            href={routes.competition(orgSlug, compSlug)}
            className="mt-3 inline-block font-semibold underline"
          >
            Back to the competition →
          </Link>
        </div>
      ) : isPro ? (
        <div className="mt-6 rounded-lg border border-purple-200 bg-purple-50 p-5 text-sm text-purple-900">
          <p className="font-semibold">You’re on Pro</p>
          <p className="mt-1">
            Pro already covers everything an Event Pass adds — across every
            competition in your organization.
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 text-slate-600">
            One payment upgrades this competition for its lifetime — no
            subscription, and it survives forever even if you never go Pro.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="card p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-purple-500">
                Event Pass
              </p>
              <p className="mt-1 text-3xl font-bold text-slate-900">
                {formatMinor(passPrice(currency), currency)}
                <span className="text-base font-normal text-slate-500"> one-time</span>
              </p>
              <ul className="mt-4 space-y-2 text-sm text-slate-600">
                {PASS_INCLUDES.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-emerald-500">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                {isOwner ? (
                  <PassUpgradeButton
                    competitionId={compId}
                    label={`Upgrade this event — ${formatMinor(passPrice(currency), currency)}`}
                  />
                ) : (
                  <p className="text-sm text-slate-500">
                    Only the organization owner can purchase upgrades.
                  </p>
                )}
              </div>
            </div>

            <div className="card border-dashed p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Running events all year?
              </p>
              <p className="mt-1 text-3xl font-bold text-slate-900">
                {formatMinor(proPrice("monthly", currency), currency)}
                <span className="text-base font-normal text-slate-500">/month</span>
              </p>
              <p className="mt-4 text-sm text-slate-600">
                Pro upgrades every competition in your organization — unlimited
                events and divisions, 256 entrants per division, player stats,
                officials, API access and a 2% platform fee.
              </p>
              <Link
                href={routes.billing(orgSlug)}
                className="btn btn-ghost mt-5 inline-block px-5 py-2.5"
              >
                Go Pro — 14-day free trial →
              </Link>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

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
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

const PASS_INCLUDE_KEYS = [
  "upgrade.includes.divisions",
  "upgrade.includes.entrants",
  "upgrade.includes.formats",
  "upgrade.includes.fees",
  "upgrade.includes.branding",
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
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">
        {t(dict, "upgrade.title", { name: page.competition.name })}
      </h1>

      {pass ? (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900" data-pass-active>
          <p className="font-semibold">{t(dict, "upgrade.active.title")}</p>
          <p className="mt-1">
            {t(dict, "upgrade.active.body")}
          </p>
          <Link
            href={routes.competition(orgSlug, compSlug)}
            className="mt-3 inline-block font-semibold underline"
          >
            {t(dict, "upgrade.backToCompetition")} →
          </Link>
        </div>
      ) : isPro ? (
        <div className="mt-6 rounded-lg border border-purple-200 bg-purple-50 p-5 text-sm text-purple-900">
          <p className="font-semibold">{t(dict, "upgrade.pro.title")}</p>
          <p className="mt-1">
            {t(dict, "upgrade.pro.body")}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 text-slate-600">
            {t(dict, "upgrade.intro")}
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="card p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-purple-500">
                {t(dict, "upgrade.eventPass")}
              </p>
              <p className="mt-1 text-3xl font-bold text-slate-900">
                {formatMinor(passPrice(currency), currency)}
                <span className="text-base font-normal text-slate-500"> {t(dict, "upgrade.oneTime")}</span>
              </p>
              <ul className="mt-4 space-y-2 text-sm text-slate-600">
                {PASS_INCLUDE_KEYS.map((key) => (
                  <li key={key} className="flex items-start gap-2">
                    <span className="mt-0.5 text-emerald-500">✓</span>
                    {t(dict, key)}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                {isOwner ? (
                  <PassUpgradeButton
                    competitionId={compId}
                    label={t(dict, "upgrade.buyLabel", {
                      price: formatMinor(passPrice(currency), currency),
                    })}
                  />
                ) : (
                  <p className="text-sm text-slate-500">
                    {t(dict, "upgrade.ownerOnly")}
                  </p>
                )}
              </div>
            </div>

            <div className="card border-dashed p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t(dict, "upgrade.proCard.title")}
              </p>
              <p className="mt-1 text-3xl font-bold text-slate-900">
                {formatMinor(proPrice("monthly", currency), currency)}
                <span className="text-base font-normal text-slate-500">{t(dict, "upgrade.perMonth")}</span>
              </p>
              <p className="mt-4 text-sm text-slate-600">
                {t(dict, "upgrade.proCard.body")}
              </p>
              <Link
                href={routes.billing(orgSlug)}
                className="btn btn-ghost mt-5 inline-block px-5 py-2.5"
              >
                {t(dict, "upgrade.proCard.cta")} →
              </Link>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

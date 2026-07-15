import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { buildPricingRows, type MatrixData } from "@/lib/pricing-matrix";
import { FREE_FEATURES, PASS_FEATURES, PRO_FEATURES } from "@/lib/pricing-cards";
import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { ProPriceCard } from "@/components/pro-price-card";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

// The switcher cookie re-renders prices per request.
export const dynamic = "force-dynamic";

const FAQ_KEYS = [
  "card",
  "eventPass",
  "upgraded",
  "trialEnd",
  "fees",
  "currencies",
  "annual",
  "cancel",
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "pricing.meta.title"),
    description: t(d, "pricing.meta.description"),
    alternates: {
      canonical: `/${lang}/pricing`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/pricing`])),
        "x-default": "/en/pricing",
      },
    },
  };
}

async function loadMatrix(): Promise<MatrixData> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key in ('community', 'event_pass', 'pro')`;
  const data: MatrixData = {};
  for (const r of rows) {
    (data[r.feature_key] ??= {})[r.plan_key] = {
      bool_value: r.bool_value,
      int_value: r.int_value,
    };
  }
  return data;
}

export default async function PricingPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");

  const currency: Currency = await preferredCurrency(null);
  // The comparison table renders from plan_entitlements so marketing can
  // never drift from what the resolver enforces (v3/07 §5). DB may be
  // unreachable at build: fail soft to an empty table.
  const rows = buildPricingRows(await loadMatrix().catch(() => ({})));

  const passLabel = formatMinor(passPrice(currency), currency);
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);

  return (
    <>
      <TrackOnMount event={EVENTS.PRICING_VIEWED} />
      <MarketingShell lang={lang}>
        <main>
          <section className="mx-auto max-w-5xl px-4 pb-14 pt-16 text-center">
            <p className="mk-eyebrow mb-3 justify-center">{t(d, "pricing.eyebrow")}</p>
            <h1 className="mk-display mb-3 text-5xl font-bold text-purple-950 sm:text-6xl">
              {t(d, "pricing.title")}
            </h1>
            <p className="text-lg text-slate-600">{t(d, "pricing.subhead")}</p>
            <div className="mt-6 flex justify-center">
              <CurrencySwitcher current={currency} />
            </div>
          </section>

          {/* Three offers (v3/07 §5) */}
          <section className="mx-auto max-w-5xl px-4 pb-20">
            <div className="grid gap-6 md:grid-cols-3">
              {/* Community */}
              <div className="card flex flex-col p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {t(d, "pricing.community.name")}
                </p>
                <p className="mb-1 text-4xl font-bold text-slate-900">
                  {t(d, "pricing.community.price")}
                </p>
                <p className="mb-6 text-sm text-slate-500">{t(d, "pricing.community.note")}</p>
                <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                  {FREE_FEATURES.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-emerald-500">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/login?tab=signup" className="btn btn-ghost w-full justify-center py-3">
                  {t(d, "pricing.community.cta")}
                </Link>
              </div>

              {/* Event Pass */}
              <div className="card flex flex-col border-[#b5d977] bg-[#f7fce9] p-8">
                <p className="mk-display mb-1 text-xs font-semibold tracking-[0.18em] text-[#4d7c0f]">
                  {t(d, "pricing.pass.name")}
                </p>
                <p className="mb-1 text-4xl font-bold text-slate-900">
                  {passLabel}
                  <span className="text-lg font-normal text-slate-500">
                    {t(d, "pricing.pass.per")}
                  </span>
                </p>
                <p className="mb-6 text-sm text-slate-500">{t(d, "pricing.pass.note")}</p>
                <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                  {PASS_FEATURES.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-[#4d7c0f]">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/login?tab=signup"
                  className="btn btn-ghost w-full justify-center border-amber-300 py-3 hover:bg-amber-100"
                >
                  {t(d, "pricing.pass.cta")}
                </Link>
              </div>

              {/* Pro — annual toggle default-on */}
              <ProPriceCard
                monthly={proMonthly}
                annualPerMonth={formatMinor(Math.round(proPrice("annual", currency) / 12), currency)}
                annualTotal={formatMinor(proPrice("annual", currency), currency)}
                features={PRO_FEATURES}
              />
            </div>

            {/* Feature comparison table — rendered from plan_entitlements. */}
            {rows.length > 0 && (
              <div className="scroll-x scroll-x-fade mt-12 rounded-2xl border border-purple-100 bg-white">
                <table className="table w-full" data-pricing-matrix>
                  <thead>
                    <tr>
                      <th className="py-3 text-left">{t(d, "pricing.table.feature")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.community")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.pass")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.pro")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {rows.map((r) => (
                      <tr key={r.label}>
                        <td className="font-medium text-slate-700">{r.label}</td>
                        <td className="text-center text-slate-500">{r.free}</td>
                        <td className="text-center text-[#4d7c0f]">{r.pass}</td>
                        <td className="text-center font-medium text-purple-700">{r.pro}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-6 text-center text-sm text-slate-500">
              {t(d, "pricing.enterprise.text")}{" "}
              <a href="mailto:hello@seazn.club" className="font-medium text-purple-700 underline">
                {t(d, "pricing.enterprise.link")}
              </a>
              .
            </p>
          </section>

          {/* FAQ */}
          <section className="bg-purple-50 py-16">
            <div className="mx-auto max-w-3xl px-4">
              <h2 className="mb-10 text-center text-2xl font-bold text-purple-900">
                {t(d, "pricing.faq.heading")}
              </h2>
              <div className="space-y-6">
                {FAQ_KEYS.map((k) => (
                  <div key={k} className="card p-6">
                    <h3 className="mb-2 font-semibold text-slate-800">
                      {t(d, `pricing.faq.${k}.q`)}
                    </h3>
                    <p className="text-sm text-slate-600">{t(d, `pricing.faq.${k}.a`)}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="bg-purple-900 py-14 text-center text-white">
            <h2 className="mb-3 text-2xl font-bold">{t(d, "pricing.final.title")}</h2>
            <p className="mb-6 text-purple-200">{t(d, "pricing.final.subhead")}</p>
            <Link
              href="/login?tab=signup"
              className="btn bg-white px-8 py-3 text-base font-semibold text-purple-900 hover:bg-purple-50"
            >
              {t(d, "pricing.final.cta")}
            </Link>
          </section>
        </main>
      </MarketingShell>
    </>
  );
}

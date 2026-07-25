import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { buildPricingSections, type MatrixData } from "@/lib/pricing-matrix";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  PLUS_CARD_FEATURES,
  PLUS_COMING_SOON,
  PASS_CREDIT_GRANT,
} from "@/lib/pricing-cards";
import { formatMinor, passPrice, proPrice, proPlusPrice, type Currency } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { pickActiveOrg } from "@/lib/active-org";
import { isPaidPlan, orgPlanKey } from "@/lib/entitlements";
import { passCtaVariant } from "@/lib/pass-cta";
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
  "groups",
  "currencies",
  "annual",
  "cancel",
  "proPlus",
] as const;

// `pricing.meta.description` quotes USD amounts deliberately, unlike the page
// body, which honours the currency switcher. Metadata is what a crawler reads,
// and a crawler carries no switcher cookie — it would always resolve to the
// USD default anyway, so reading the cookie here would buy nothing and make the
// <meta> vary per visitor for no SEO gain. One canonical currency, kept
// accurate: the amounts must be re-checked whenever stripe-plans.json moves.
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

/**
 * Resolve the viewer's Event Pass call-to-action.
 *
 * The plan comes from `orgPlanKey` + `isPaidPlan` — the entitlement resolver's
 * own derivation — so "what we sell here" cannot drift from "what we grant".
 * A user with no org yet reads as community: they are one signup step from one.
 */
async function passColumnCta(): Promise<ReturnType<typeof passCtaVariant>> {
  const user = await getCurrentUser();
  if (!user) return passCtaVariant({ signedIn: false, paidPlan: false });
  const orgs = await getUserOrgs(user.id);
  // No path segment to read on a marketing page — the cookie is all there is.
  const active = pickActiveOrg(orgs, { cookieOrgId: await getActiveOrgId() });
  const paidPlan = active ? isPaidPlan(await orgPlanKey(active.id)) : false;
  return passCtaVariant({ signedIn: true, paidPlan });
}

async function loadMatrix(): Promise<MatrixData> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key in ('community', 'event_pass', 'pro', 'pro_plus')`;
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
  // The comparison table AND the per-card credit lines render from
  // plan_entitlements so marketing can never drift from what the resolver
  // enforces (spec 2026-07-18 pro-plus-tier §5; v17 SPEC-6 A1 for credits). DB
  // may be unreachable at build: fail soft to an empty table.
  const matrix: MatrixData = await loadMatrix().catch(() => ({}));
  const sections = buildPricingSections(matrix);

  // v17 AI credit wallet (SPEC-6 A1): each plan's monthly grant is the live
  // `ai.credits.monthly` value — the same single source the wallet meters
  // against — so the marketing number cannot drift. The Event Pass adds a
  // one-time top-up (PASS_CREDIT_GRANT); it has no monthly matrix row.
  const creditsMonthly = (plan: string): number | null =>
    matrix["ai.credits.monthly"]?.[plan]?.int_value ?? null;
  const communityCredits = creditsMonthly("community");
  const proCredits = creditsMonthly("pro");
  const plusCredits = creditsMonthly("pro_plus");
  const communityCreditsLine =
    communityCredits != null ? t(d, "pricing.credits.perMonth", { count: communityCredits }) : null;
  const passCreditsLine = t(d, "pricing.credits.passGrant", { count: PASS_CREDIT_GRANT });
  const proCreditsLine =
    proCredits != null ? t(d, "pricing.credits.perMonth", { count: proCredits }) : null;
  const plusCreditsLine =
    plusCredits != null ? t(d, "pricing.credits.perMonthOperator", { count: plusCredits }) : null;

  const passLabel = formatMinor(passPrice(currency), currency);
  // Who is reading the Event Pass column? An anonymous visitor still gets the
  // signup path; a signed-in organiser gets handed to their competition list,
  // which is the only place a pass can actually be bought. The nav on this very
  // page already resolves the viewer this way (MarketingNav → /dashboard).
  // Fail soft to the anonymous column — a marketing page must render even if
  // the session or the plan read is unavailable.
  const passCta = await passColumnCta().catch(() => "signup" as const);
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);
  const plusMonthly = formatMinor(proPlusPrice("monthly", currency), currency);

  // The FAQ used to hardcode "$19/mo" while the cards above it honoured the
  // currency switcher — a GBP visitor saw £ and $ on one page. Every answer is
  // interpolated with the same switched amounts instead; `t()` leaves an answer
  // without placeholders untouched, so only the ones that quote a price change.
  const faqVars = {
    pass: passLabel,
    pro: proMonthly,
    proAnnual: formatMinor(proPrice("annual", currency), currency),
    plus: plusMonthly,
    plusAnnual: formatMinor(proPlusPrice("annual", currency), currency),
  };

  // Most matrix cells are locale-free literals (numbers, ∞, ✓, —); only the
  // "passedEvent" prose cell is a real dict key (see lib/pricing-matrix).
  const cellText = (value: string): string =>
    value.startsWith("pricing.matrix.") ? t(d, value) : value;

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

          {/* Four offers — v17 ladder (SPEC-6 A1): Community / Event Pass / Pro
              / Pro Plus, each carrying the two v17 differentiators (fee % + the
              credit line). Stacks on mobile, 2-up on tablet, 4-up on desktop —
              no horizontal scroll at 375px. */}
          <section className="mx-auto max-w-6xl px-4 pb-20">
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
              {/* Community */}
              <div className="card flex flex-col p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {t(d, "pricing.community.name")}
                </p>
                <p className="mb-1 text-4xl font-bold text-slate-900">
                  {t(d, "pricing.community.price")}
                </p>
                <p className="mb-4 text-sm text-slate-500">{t(d, "pricing.community.note")}</p>
                {communityCreditsLine && (
                  <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                    <span aria-hidden>⚡</span>
                    {communityCreditsLine}
                  </p>
                )}
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
                <p className="mb-4 text-sm text-slate-500">{t(d, "pricing.pass.note")}</p>
                <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-[#eaf6cf] px-3 py-2 text-sm font-semibold text-[#4d7c0f]">
                  <span aria-hidden>⚡</span>
                  {passCreditsLine}
                </p>
                <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                  {PASS_FEATURES.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-[#4d7c0f]">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {/* Three readers, three honest endings (task 19, spec D3).
                    `included` is not a disabled button: a paying customer is
                    not being refused, the offer simply does not apply to
                    them — Pro already exceeds every key the pass lifts. */}
                {passCta === "included" ? (
                  <p
                    data-pass-column-cta="included"
                    className="rounded-xl bg-white/70 px-4 py-3 text-center text-sm font-medium text-[#4d7c0f]"
                  >
                    {t(d, "pricing.pass.included")}
                  </p>
                ) : (
                  <Link
                    href={passCta === "console" ? "/dashboard" : "/login?tab=signup"}
                    data-pass-column-cta={passCta}
                    className="btn btn-ghost w-full justify-center border-amber-300 py-3 hover:bg-amber-100"
                  >
                    {passCta === "console"
                      ? t(d, "pricing.pass.ctaSignedIn")
                      : t(d, "pricing.pass.cta")}
                  </Link>
                )}
              </div>

              {/* Pro — annual toggle default-on */}
              <ProPriceCard
                monthly={proMonthly}
                annualPerMonth={formatMinor(Math.round(proPrice("annual", currency) / 12), currency)}
                annualTotal={formatMinor(proPrice("annual", currency), currency)}
                features={PRO_FEATURES}
                creditsLine={proCreditsLine ?? undefined}
                ctaLabel={t(d, "pricing.plus.cta")}
              />

              {/* Pro Plus — v17 (SPEC-6 A1): promoted from the old progressive
                  disclosure to a full fourth card, the visual hero (Popular
                  badge + subtle glow via the existing shadow pattern). Carries
                  its Live features AND the badged, non-clickable "Coming soon"
                  roadmap (SPEC-1 §6 ethics: never gates money). */}
              <div
                data-plus-card
                className="card relative flex flex-col border-indigo-400 bg-indigo-50 p-8 shadow-[0_0_34px_rgba(99,102,241,0.22)]"
              >
                <span className="mk-display absolute -top-3 right-6 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold tracking-wider text-white">
                  {t(d, "pricing.plus.popular")}
                </span>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-indigo-500">
                  {t(d, "pricing.plus.name")}
                </p>
                <p className="mb-1 text-4xl font-bold text-indigo-900">
                  {plusMonthly}
                  <span className="text-lg font-normal text-slate-500">
                    {t(d, "pricing.plus.per")}
                  </span>
                </p>
                <p className="mb-4 text-sm text-slate-500">{t(d, "pricing.plus.note")}</p>
                {plusCreditsLine && (
                  <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-indigo-100 px-3 py-2 text-sm font-semibold text-indigo-800">
                    <span aria-hidden>⚡</span>
                    {plusCreditsLine}
                  </p>
                )}
                <ul className="mb-6 flex-1 space-y-2.5 text-sm text-slate-600">
                  {/* PLUS_CARD_FEATURES pins the count/order (matches Task 8's
                      billing.plus.f1-f5); the text itself is fully localized,
                      unlike the other three cards' hardcoded-English arrays. */}
                  {PLUS_CARD_FEATURES.map((_, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-0.5 text-indigo-500">✓</span>
                      {t(d, `pricing.plus.f${i + 1}`)}
                    </li>
                  ))}
                </ul>
                {/* Roadmap (SPEC-1 §6): badged "coming soon", NOT purchasable —
                    plain non-interactive text, never buttons/links. Muted so the
                    tier's ceiling reads as ambition rather than a paywall. */}
                <div className="mb-8 rounded-xl border border-indigo-100 bg-white/60 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-400">
                    {t(d, "pricing.plus.soonLabel")}
                  </p>
                  <ul className="space-y-1.5 text-sm text-slate-500">
                    {PLUS_COMING_SOON.map((_, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-0.5 text-indigo-300">◦</span>
                        {t(d, `pricing.plus.soon${i + 1}`)}
                      </li>
                    ))}
                  </ul>
                </div>
                <Link
                  href="/login?tab=signup"
                  className="btn w-full justify-center bg-indigo-600 py-3 text-white hover:bg-indigo-700"
                >
                  {t(d, "pricing.plus.cta")}
                </Link>
              </div>
            </div>

            {/* Add-ons strip (SPEC-6 A1): the recurring + one-time extras sit
                beneath the tier ladder. Non-committal labels — the actual
                purchase surfaces are later SPEC-6 billing tabs — so these are
                static, not links, and never gate money. */}
            <div className="mt-8 rounded-2xl border border-purple-100 bg-purple-50/60 px-6 py-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
                <span className="text-xs font-semibold uppercase tracking-wider text-purple-500">
                  {t(d, "pricing.addons.label")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>⚡</span>
                  {t(d, "pricing.addons.credits")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>＋</span>
                  {t(d, "pricing.addons.seat")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>＋</span>
                  {t(d, "pricing.addons.org")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>⤢</span>
                  {t(d, "pricing.addons.sizePack")}
                </span>
              </div>
            </div>

            {/* Feature comparison table — rendered from plan_entitlements,
                grouped into ENTITLEMENT_DOMAINS sections. Always 4 plan
                columns, matching the four cards above. */}
            {sections.length > 0 && (
              <div className="scroll-x scroll-x-fade mt-12 rounded-2xl border border-purple-100 bg-white">
                <table className="table w-full" data-pricing-matrix>
                  <thead>
                    <tr>
                      <th className="py-3 text-left">{t(d, "pricing.table.feature")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.community")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.pass")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.pro")}</th>
                      <th className="py-3 text-center">{t(d, "pricing.table.proPlus")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {sections.map((section) => (
                      <Fragment key={section.labelKey}>
                        <tr>
                          <td
                            colSpan={5}
                            className="bg-purple-50/60 pt-5 pb-1.5 text-xs font-semibold uppercase tracking-wider text-purple-500"
                          >
                            {t(d, section.labelKey)}
                          </td>
                        </tr>
                        {section.rows.map((r) => (
                          <tr key={r.labelKey}>
                            <td className="font-medium text-slate-700">
                              {t(d, r.labelKey)}
                              {/* A count that is really a price gets a second
                                  line, so the number is never read as an
                                  allowance (billing groups, spec 2026-07-21). */}
                              {r.noteKey && (
                                <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                  {t(d, r.noteKey)}
                                </span>
                              )}
                            </td>
                            <td className="text-center text-slate-500">{cellText(r.free)}</td>
                            <td className="text-center text-[#4d7c0f]">{cellText(r.pass)}</td>
                            <td className="text-center font-medium text-purple-700">{cellText(r.pro)}</td>
                            <td className="text-center font-medium text-indigo-700">{cellText(r.plus)}</td>
                          </tr>
                        ))}
                      </Fragment>
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
                    <p className="text-sm text-slate-600">{t(d, `pricing.faq.${k}.a`, faqVars)}</p>
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

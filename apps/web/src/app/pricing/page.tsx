import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "@/lib/db";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import { buildPricingRows, type MatrixData } from "@/lib/pricing-matrix";
import { FREE_FEATURES, PASS_FEATURES, PRO_FEATURES } from "@/lib/pricing-cards";
import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { ProPriceCard } from "@/components/pro-price-card";

// The switcher cookie re-renders prices per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — Seazn Club",
  description:
    "Free forever for small clubs. Upgrade a single event for $39, or go Pro at $20/month for unlimited competitions, entry fees, and realtime scoreboards. 14-day trial, no card required.",
};

const FAQS = [
  {
    q: "Do I need a credit card to start?",
    a: "No. The Community plan is free forever and requires no payment details. The Pro trial also starts without a card.",
  },
  {
    q: "What exactly does an Event Pass cover?",
    a: "One competition, for its lifetime. That competition gets 10 divisions, 32 entrants per division, advanced formats, entry fees, branding, exports and realtime — and it stops counting against your free active-competition slot. Other competitions in your org stay on Community limits.",
  },
  {
    q: "I bought an Event Pass and later went Pro — what happens?",
    a: "Pro covers everything the pass does, org-wide, so the pass sits dormant. If you ever cancel Pro, passed competitions stay upgraded — passes never expire.",
  },
  {
    q: "What happens when my Pro trial or subscription ends?",
    a: "Your org drops back to Community limits automatically. Nothing is deleted — competitions over the limit become read-only until you archive down to quota or upgrade again.",
  },
  {
    q: "Can I charge entry fees?",
    a: "Yes — with an Event Pass (5% platform fee on that competition) or on Pro (2% org-wide). Connect your club's Stripe account and fees from online registration are paid out directly to the club. Free-event registration works on every plan.",
  },
  {
    q: "Which currencies can I pay in?",
    a: "USD, EUR, GBP, INR and AUD — use the switcher above. Your first checkout pins the currency for future renewals.",
  },
  {
    q: "Is there an annual discount?",
    a: "Yes — annual billing is two months free (17% off), and it's the default on the Pro card above.",
  },
  {
    q: "Can I cancel any time?",
    a: "Yes. Cancel from Settings → Billing. Your Pro access continues until the end of the billing period.",
  },
];

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

export default async function PricingPage() {
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
      <MarketingNav />
      <main>
        <section className="mx-auto max-w-5xl px-4 pb-14 pt-16 text-center">
          <h1 className="mb-3 text-4xl font-extrabold tracking-tight text-purple-950 sm:text-5xl">
            Pay for the event, or the whole season
          </h1>
          <p className="text-lg text-slate-600">
            Free for small clubs. One-time Event Pass for the yearly tournament.
            Pro when you run competitions all year.
          </p>
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
                Community
              </p>
              <p className="mb-1 text-4xl font-bold text-slate-900">Free</p>
              <p className="mb-6 text-sm text-slate-500">Forever, no card needed.</p>
              <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                {FREE_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-emerald-500">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/login?tab=signup" className="btn btn-ghost w-full justify-center py-3">
                Get started free
              </Link>
            </div>

            {/* Event Pass */}
            <div className="card flex flex-col border-amber-300 bg-amber-50/60 p-8">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-600">
                Event Pass
              </p>
              <p className="mb-1 text-4xl font-bold text-slate-900">
                {passLabel}
                <span className="text-lg font-normal text-slate-500"> / event</span>
              </p>
              <p className="mb-6 text-sm text-slate-500">
                One-time. No subscription. Yours for the event’s lifetime.
              </p>
              <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                {PASS_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-amber-500">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/login?tab=signup" className="btn btn-ghost w-full justify-center border-amber-300 py-3 hover:bg-amber-100">
                Start free, upgrade in-app
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
                    <th className="py-3 text-left">Feature</th>
                    <th className="py-3 text-center">Community</th>
                    <th className="py-3 text-center">Event Pass</th>
                    <th className="py-3 text-center">Pro</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <td className="font-medium text-slate-700">{r.label}</td>
                      <td className="text-center text-slate-500">{r.free}</td>
                      <td className="text-center text-amber-700">{r.pass}</td>
                      <td className="text-center font-medium text-purple-700">{r.pro}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-6 text-center text-sm text-slate-500">
            Need more than Pro — federations, leagues at scale, SSO?{" "}
            <a href="mailto:hello@seazn.club" className="font-medium text-purple-700 underline">
              Talk to us
            </a>
            .
          </p>
        </section>

        {/* FAQ */}
        <section className="bg-purple-50 py-16">
          <div className="mx-auto max-w-3xl px-4">
            <h2 className="mb-10 text-center text-2xl font-bold text-purple-900">
              Frequently asked questions
            </h2>
            <div className="space-y-6">
              {FAQS.map((faq) => (
                <div key={faq.q} className="card p-6">
                  <h3 className="mb-2 font-semibold text-slate-800">{faq.q}</h3>
                  <p className="text-sm text-slate-600">{faq.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-purple-900 py-14 text-center text-white">
          <h2 className="mb-3 text-2xl font-bold">Start for free today</h2>
          <p className="mb-6 text-purple-200">
            No card required. Upgrade a single event, or the whole club, when it grows.
          </p>
          <Link href="/login?tab=signup" className="btn bg-white px-8 py-3 text-base font-semibold text-purple-900 hover:bg-purple-50">
            Create your free account →
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </>
  );
}

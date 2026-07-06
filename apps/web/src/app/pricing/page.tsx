import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: "Pricing — Seazn Club",
  description:
    "Free forever for small clubs. Pro at $20/month for unlimited competitions, online registration with entry fees, and realtime scoreboards. 14-day trial, no card required.",
};

const FREE = [
  "2 active competitions",
  "1 division per competition",
  "16 entrants per division",
  "League, groups + knockout & swiss formats",
  "Free-event online registration",
  "Live standings & public dashboard",
  "1 scorer seat + 3 team members",
  "Listed on the seazn.club showcase",
];

const PRO = [
  "Unlimited active competitions",
  "10 divisions per competition, 64 entrants each",
  "Online registration with entry fees — paid out to your club",
  "Realtime scoreboards & live push updates",
  "Ball-by-ball & rally-by-rally scoring, player stats",
  "Custom branding, CSV/PDF exports, API keys",
  "Hand-over device links for courtside volunteers",
  "Priority support",
];

const FAQS = [
  {
    q: "Do I need a credit card to start?",
    a: "No. The Community plan is free forever and requires no payment details. The Pro trial also starts without a card.",
  },
  {
    q: "What happens when my Pro trial ends?",
    a: "Your org drops back to Community limits automatically. Your data is preserved — no competitions are deleted. You can upgrade again any time.",
  },
  {
    q: "Can I charge entry fees?",
    a: "Yes — on Pro. Connect your club's Stripe account from the registration console and fees from online registration are paid out directly to the club, minus a small platform fee. Free-event registration works on every plan.",
  },
  {
    q: "Can I have multiple organizations?",
    a: "Yes. Each org has its own subscription. You can be a member of many orgs simultaneously.",
  },
  {
    q: "Is there an annual discount?",
    a: "Annual billing with a discount is coming soon. Join Pro monthly now and we'll offer the switch when it launches.",
  },
  {
    q: "What payment methods do you accept?",
    a: "All major credit and debit cards via Stripe. Stripe Tax is applied where required.",
  },
  {
    q: "Can I cancel any time?",
    a: "Yes. Cancel from Settings → Billing. Your Pro access continues until the end of the billing period.",
  },
];

export default function PricingPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-20 pt-16 text-center">
          <h1 className="mb-3 text-4xl font-extrabold tracking-tight text-purple-950 sm:text-5xl">
            Simple, honest pricing
          </h1>
          <p className="text-lg text-slate-600">
            Free for small clubs. Pro when you need to scale.
          </p>
        </section>

        {/* Plan cards */}
        <section className="mx-auto max-w-4xl px-4 pb-20">
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Community */}
            <div className="card flex flex-col p-8">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Community
              </p>
              <p className="mb-1 text-4xl font-bold text-slate-900">Free</p>
              <p className="mb-6 text-sm text-slate-500">Forever, no card needed.</p>
              <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                {FREE.map((f) => (
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

            {/* Pro */}
            <div className="card flex flex-col border-purple-400 bg-purple-50 p-8">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-purple-500">
                Pro
              </p>
              <p className="mb-1 text-4xl font-bold text-purple-900">
                $20
                <span className="text-lg font-normal text-slate-500">/month</span>
              </p>
              <p className="mb-6 text-sm text-slate-500">
                14-day free trial · Cancel any time.
              </p>
              <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                {PRO.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-purple-500">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/login?tab=signup" className="btn btn-primary w-full justify-center py-3">
                Start 14-day trial →
              </Link>
            </div>
          </div>

          {/* Feature comparison table */}
          <div className="mt-12 overflow-hidden rounded-2xl border border-purple-100 bg-white">
            <table className="table w-full">
              <thead>
                <tr>
                  <th className="py-3 text-left">Feature</th>
                  <th className="py-3 text-center">Community</th>
                  <th className="py-3 text-center">Pro</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {[
                  ["Active competitions", "2", "Unlimited"],
                  ["Divisions per competition", "1", "10"],
                  ["Entrants per division", "16", "64"],
                  ["Formats", "League · groups · KO · swiss", "+ double elimination"],
                  ["Online registration", "Free events", "+ entry fees via Stripe"],
                  ["Public dashboards", "1", "Unlimited"],
                  ["Realtime scoreboard", "—", "✓"],
                  ["Ball-by-ball / rally scoring", "—", "✓"],
                  ["Custom branding", "—", "✓"],
                  ["CSV / PDF exports", "—", "✓"],
                  ["API access & device links", "—", "✓"],
                  ["Team members", "3 + 1 scorer", "10 + 1 scorer"],
                  ["Priority support", "—", "✓"],
                ].map(([feature, free, pro]) => (
                  <tr key={feature}>
                    <td className="font-medium text-slate-700">{feature}</td>
                    <td className="text-center text-slate-500">{free}</td>
                    <td className="text-center font-medium text-purple-700">{pro}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            No card required. Upgrade when your club grows.
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

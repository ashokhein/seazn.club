import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: "Sub-processors — Seazn Club",
};

const SUB_PROCESSORS = [
  {
    name: "Supabase",
    purpose: "Database (PostgreSQL), authentication infrastructure",
    location: "EU (AWS eu-west-2)",
    url: "https://supabase.com/privacy",
  },
  {
    name: "Vercel",
    purpose: "Serverless hosting and edge runtime",
    location: "EU / global CDN",
    url: "https://vercel.com/legal/privacy-policy",
  },
  {
    name: "Stripe",
    purpose: "Payment processing and subscription management",
    location: "US / EU",
    url: "https://stripe.com/privacy",
  },
  {
    name: "Resend",
    purpose: "Transactional email delivery",
    location: "US / EU",
    url: "https://resend.com/privacy",
  },
];

export default function SubProcessorsPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Sub-processors</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 30 June 2026</p>
        <p className="mb-8 text-sm text-slate-600">
          Seazn Club uses the following sub-processors to provide the
          service. All sub-processors are bound by data processing agreements
          and operate under equivalent data protection standards.
        </p>

        <div className="scroll-x scroll-x-fade rounded-2xl border border-purple-100 bg-white">
          <table className="table w-full">
            <thead>
              <tr>
                <th>Service</th>
                <th>Purpose</th>
                <th>Location</th>
                <th>Privacy</th>
              </tr>
            </thead>
            <tbody>
              {SUB_PROCESSORS.map((sp) => (
                <tr key={sp.name}>
                  <td className="font-semibold text-slate-800">{sp.name}</td>
                  <td>{sp.purpose}</td>
                  <td>{sp.location}</td>
                  <td>
                    <a
                      href={sp.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-600 underline"
                    >
                      Policy ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-8 text-sm text-slate-500">
          We will notify customers of additions or changes to this list with
          reasonable prior notice. Questions: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a>
        </p>
      </main>
      <MarketingFooter />
    </>
  );
}

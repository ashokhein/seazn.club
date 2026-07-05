import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: "Cookie Policy — Seazn Club",
};

export default function CookiePolicyPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Cookie Policy</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 30 June 2026</p>
        <div className="space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">What are cookies?</h2>
            <p>Cookies are small text files stored on your device by your browser. We use them to keep you logged in and remember your preferences.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Cookies we set</h2>
            <div className="overflow-hidden rounded-xl border border-purple-100 bg-white">
              <table className="table w-full">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Purpose</th>
                    <th>Expiry</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="font-mono">seazn_session</td>
                    <td>Keeps you logged in</td>
                    <td>30 days</td>
                    <td>Essential</td>
                  </tr>
                  <tr>
                    <td className="font-mono">seazn_org</td>
                    <td>Remembers your active organisation</td>
                    <td>30 days</td>
                    <td>Functional</td>
                  </tr>
                  <tr>
                    <td className="font-mono">seazn_cookie_consent</td>
                    <td>Records that you dismissed the cookie banner</td>
                    <td>Session (localStorage)</td>
                    <td>Functional</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Third-party cookies</h2>
            <p>We do not use third-party tracking, advertising, or analytics cookies. Stripe may set cookies during the checkout flow — see <a href="https://stripe.com/cookies-policy/legal" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">Stripe's cookie policy</a>.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Managing cookies</h2>
            <p>Essential cookies are required for the service to function and cannot be disabled. You can clear all cookies through your browser settings, but this will log you out. Most browsers also offer a "Do Not Track" option.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Contact</h2>
            <p>Questions about cookies: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a></p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

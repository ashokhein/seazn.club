import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { CookieSettingsButton } from "@/components/cookie-settings-button";

export const metadata: Metadata = {
  title: "Cookie Policy — Seazn Club",
};

export default function CookiePolicyPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Cookie Policy</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 9 July 2026</p>
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
                    <td>Records your analytics consent choice</td>
                    <td>Persistent (localStorage)</td>
                    <td>Functional</td>
                  </tr>
                  <tr>
                    <td className="font-mono">ph_* / __ph_*</td>
                    <td>PostHog product analytics — only set after you Accept</td>
                    <td>1 year</td>
                    <td>Analytics (opt-in)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Third-party cookies</h2>
            <p>We use <a href="https://posthog.com/" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">PostHog</a> for product analytics to understand how Seazn Club is used and improve it. These cookies are only set if you choose <strong>Accept</strong> on the cookie banner — reject and none are set. We do not use advertising cookies. Stripe may set cookies during the checkout flow — see <a href="https://stripe.com/cookies-policy/legal" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">Stripe's cookie policy</a>.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Managing cookies</h2>
            <p>Essential cookies are required for the service to function and cannot be disabled. Analytics cookies are opt-in — you can change or withdraw your consent at any time:</p>
            <p className="mt-3">
              <CookieSettingsButton className="btn btn-ghost text-xs">
                Manage cookie preferences
              </CookieSettingsButton>
            </p>
            <p className="mt-3">You can also clear all cookies through your browser settings, but this will log you out. Most browsers also offer a "Do Not Track" option.</p>
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

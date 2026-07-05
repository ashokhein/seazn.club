import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Seazn Club",
  description: "How Seazn Club collects, uses, and protects your personal data.",
};

export default function PrivacyPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Privacy Policy</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 30 June 2026</p>
        <div className="prose prose-slate max-w-none space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">1. Who we are</h2>
            <p>Seazn Club ("we", "us") operates the tournament management platform at seazn.club. We are the data controller for personal data processed through the service.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">2. Data we collect</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Account data:</strong> email address, display name, avatar URL, password hash.</li>
              <li><strong>Organisation data:</strong> organisation name, slug, member roles.</li>
              <li><strong>Tournament data:</strong> player names, results, standings, audit logs.</li>
              <li><strong>Billing data:</strong> subscription status, plan. Card details are held by Stripe and never stored on our servers.</li>
              <li><strong>Usage data:</strong> activation funnel events (e.g. "first tournament created"). No third-party analytics.</li>
              <li><strong>Communication preferences:</strong> email suppression list (bounces / complaints).</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">3. Legal basis (GDPR)</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Contract</strong> — processing necessary to provide the service you signed up for.</li>
              <li><strong>Legitimate interests</strong> — security logging, fraud prevention, activation analytics.</li>
              <li><strong>Legal obligation</strong> — tax records, dispute resolution.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">4. How we use your data</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>Providing, operating, and improving the service.</li>
              <li>Sending transactional emails (verification, password reset, billing receipts).</li>
              <li>Detecting and preventing abuse or fraud.</li>
              <li>Responding to support requests.</li>
            </ul>
            <p className="mt-2">We do not sell your data or use it for advertising.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">5. Sub-processors</h2>
            <p>We share data with trusted sub-processors to operate the service. See our <Link href="/legal/sub-processors" className="text-purple-600 underline">sub-processors list</Link> for details.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">6. Data retention</h2>
            <p>Account data is retained for the life of your account plus 30 days after deletion. Tournament records may be anonymised rather than deleted at your request. Billing records are retained for 7 years for tax compliance.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">7. Your rights (GDPR)</h2>
            <p>You have the right to access, correct, or delete your personal data. You can export your data from Settings → Account → Export my data. To exercise other rights, email us at privacy@seazn.club. We respond within 30 days.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">8. Cookies</h2>
            <p>We use essential session cookies only. No tracking or advertising cookies. See our <Link href="/legal/cookie-policy" className="text-purple-600 underline">Cookie Policy</Link>.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">9. Security</h2>
            <p>Data is encrypted in transit (TLS) and at rest. Passwords are hashed with bcrypt. Access is controlled by row-level security policies at the database level. Staff access is logged and audited.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">10. Changes</h2>
            <p>We will notify you by email of material changes to this policy at least 14 days in advance.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">11. Contact</h2>
            <p>Privacy questions: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a></p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

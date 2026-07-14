import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Seazn Club",
};

export default function TermsPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Terms of Service</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 14 July 2026</p>
        <div className="space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">1. Acceptance</h2>
            <p>By creating an account or using Seazn Club you agree to these Terms. If you do not agree, do not use the service. These Terms form a binding contract between you and Seazn Club.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">2. Service description</h2>
            <p>Seazn Club is a tournament management platform for sports clubs, academies, and events. We provide software-as-a-service (SaaS) accessible via the web.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">3. Accounts</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>You must provide accurate information when registering.</li>
              <li>You are responsible for maintaining the security of your account credentials.</li>
              <li>You must be at least 16 years old to create an account.</li>
              <li>You may not share accounts or use the service to create accounts on behalf of others without authorisation.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">4. Subscriptions and billing</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>The Community plan is free with limits described on the <Link href="/pricing" className="text-purple-600 underline">pricing page</Link>.</li>
              <li>Pro subscriptions are billed monthly in advance. Prices are in USD.</li>
              <li>Trials are 14 days and automatically convert to a paid subscription unless cancelled before the trial ends.</li>
              <li>Refunds are not provided for partial billing periods. Contact support for exceptional cases.</li>
              <li>We reserve the right to change prices with 30 days' notice.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">5. Entry-fee chargebacks</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>Card entry fees are collected through Stripe Connect and settle to your organisation&apos;s connected Stripe account. Seazn Club acts as merchant of record and manages responses to payment disputes (chargebacks) on your behalf.</li>
              <li>Your organisation bears the cost of chargebacks on its entry fees. If a dispute is lost, the disputed amount is recovered from your connected Stripe balance; where the balance cannot cover it, Stripe recovers the difference from your future payouts or linked bank account under its Connect terms.</li>
              <li>Seazn Club covers Stripe&apos;s dispute fees.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">6. Acceptable use</h2>
            <p>You may not:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Use the service for unlawful purposes or to violate others' rights.</li>
              <li>Upload content that is abusive, defamatory, or infringes intellectual property.</li>
              <li>Attempt to gain unauthorised access to other users' data or our systems.</li>
              <li>Reverse-engineer, scrape, or abuse the API beyond normal use.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">7. Your data</h2>
            <p>You retain ownership of data you upload. By using the service you grant us a limited licence to store and process that data to provide the service. See our <Link href="/legal/privacy" className="text-purple-600 underline">Privacy Policy</Link> for details.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">8. Availability and SLA</h2>
            <p>We aim for high availability but do not guarantee uninterrupted access. Planned maintenance will be communicated in advance. The service is provided "as is" without warranty of any kind.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">9. Limitation of liability</h2>
            <p>To the maximum extent permitted by law, Seazn Club' total liability for any claim arising from use of the service is limited to the amount you paid us in the 12 months preceding the claim. We are not liable for indirect, incidental, or consequential damages.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">10. Termination</h2>
            <p>You may close your account at any time from Settings → Account. We may suspend or terminate accounts that violate these Terms, with or without notice depending on severity. On termination, your data is scheduled for deletion as described in our Privacy Policy.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">11. Governing law</h2>
            <p>These Terms are governed by the laws of England and Wales. Disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">12. Changes</h2>
            <p>We will notify you of material changes by email at least 14 days before they take effect. Continued use after that date constitutes acceptance.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">13. Contact</h2>
            <p><a href="mailto:legal@seazn.club" className="text-purple-600 underline">legal@seazn.club</a></p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

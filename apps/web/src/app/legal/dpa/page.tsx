import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: "Data Processing Agreement — Seazn Club",
};

export default function DpaPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">
          Data Processing Agreement (DPA)
        </h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 30 June 2026</p>
        <div className="space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">1. Scope</h2>
            <p>This Data Processing Agreement ("DPA") applies when Seazn Club processes personal data on behalf of a customer ("Controller") acting as a data processor under applicable data protection law, including the UK GDPR and EU GDPR.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">2. Roles</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Controller:</strong> The organisation or individual that has created an account and determines the purposes and means of data processing (typically the org owner).</li>
              <li><strong>Processor:</strong> Seazn Club, which processes personal data (player names, results) as instructed by the Controller.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">3. Processing details</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Subject matter:</strong> Tournament management — player registration, results recording, standings.</li>
              <li><strong>Duration:</strong> For the term of the service agreement.</li>
              <li><strong>Nature:</strong> Storage, organisation, display of personal data.</li>
              <li><strong>Categories of data:</strong> Names, optionally avatar images. No special-category data.</li>
              <li><strong>Data subjects:</strong> Players and members of the Controller's organisation.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">4. Processor obligations</h2>
            <p>Seazn Club will:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Process data only on documented instructions from the Controller.</li>
              <li>Ensure persons authorised to process data are bound by confidentiality.</li>
              <li>Implement appropriate technical and organisational security measures.</li>
              <li>Assist the Controller in fulfilling data subject rights requests.</li>
              <li>Delete or return data at the end of the service relationship.</li>
              <li>Provide information necessary for the Controller to demonstrate compliance.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">5. Sub-processors</h2>
            <p>We use sub-processors to operate the service. See our <a href="/legal/sub-processors" className="text-purple-600 underline">sub-processor list</a>. We will notify Controllers of changes with reasonable notice.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">6. International transfers</h2>
            <p>Data may be processed in the EU or UK by our sub-processors. Where data is transferred outside the UK/EEA, we rely on Standard Contractual Clauses (SCCs) or equivalent adequacy mechanisms.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">7. Security incidents</h2>
            <p>We will notify Controllers without undue delay (within 72 hours where feasible) upon becoming aware of a personal data breach affecting their data.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">8. Requesting a DPA</h2>
            <p>If your organisation requires a signed DPA for compliance purposes, email <a href="mailto:legal@seazn.club" className="text-purple-600 underline">legal@seazn.club</a>.</p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

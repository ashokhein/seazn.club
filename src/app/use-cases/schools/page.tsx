import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: "For Schools & Youth Programs — Seazn Club",
  description:
    "Inter-house competitions, lunchtime leagues, end-of-term championships. Simple enough for students to use; powerful enough for school sports coordinators.",
};

export default function SchoolsPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16">
          <div className="mb-4">
            <Link href="/" className="text-sm text-purple-600 hover:underline">
              ← Back
            </Link>
          </div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-700">
            Use case: Schools & youth
          </div>
          <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-purple-950 sm:text-5xl">
            Tournaments that kids love to follow
          </h1>
          <p className="mb-8 max-w-2xl text-lg text-slate-600">
            Inter-house tournaments, lunchtime chess leagues, sports day
            competitions — Seazn Club keeps students engaged with live standings
            they can check from anywhere, and makes the coordinator's job easy.
          </p>

          <div className="grid gap-6 sm:grid-cols-2">
            {[
              {
                icon: "🏫",
                title: "Inter-house & inter-year",
                body: "Create separate tournament brackets per house or year group. Track points across the full term to crown a seasonal champion.",
              },
              {
                icon: "📱",
                title: "Students follow on their phones",
                body: "Share a link to the live standings. Students can check results and standings without creating an account.",
              },
              {
                icon: "🗓️",
                title: "Lunchtime leagues",
                body: "Run a rolling round-robin where each pair plays one match per week. Standings auto-update as matches are recorded.",
              },
              {
                icon: "🎓",
                title: "Multiple sports, one org",
                body: "Chess, carrom, table tennis, badminton — run all your school sports from a single organization with custom presets per sport.",
              },
              {
                icon: "🖨️",
                title: "Noticeboard-ready",
                body: "Print the bracket or standings directly from the app. Looks great on A3 for the sports hall notice board.",
              },
              {
                icon: "👨‍🏫",
                title: "Staff-level access control",
                body: "PE staff and form tutors can be added as admins. Headteachers can view results without editing access.",
              },
            ].map((f) => (
              <div key={f.title} className="card p-6">
                <div className="mb-3 text-3xl">{f.icon}</div>
                <h3 className="mb-1 font-semibold text-slate-800">{f.title}</h3>
                <p className="text-sm text-slate-500">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-purple-50 py-14 text-center">
          <h2 className="mb-3 text-2xl font-bold text-purple-900">
            Get your school started for free
          </h2>
          <p className="mb-6 text-slate-500">
            Community plan handles up to 32 players and 5 seasons — enough for
            most schools.
          </p>
          <Link href="/login?tab=signup" className="btn btn-primary px-8 py-3 text-base">
            Start free →
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </>
  );
}

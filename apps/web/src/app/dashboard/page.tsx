export const dynamic = "force-dynamic";
// Organiser home — competitions on the v2 engine (PROMPT-15 task 1).
import Link from "next/link";
import { Trophy } from "lucide-react";
import { Nav } from "@/components/nav";
import { BillingBanner } from "@/components/billing-banner";
import { requirePageAuth } from "@/server/page-auth";
import { listCompetitions } from "@/server/usecases/competitions";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  published: "bg-sky-100 text-sky-700",
  live: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  archived: "bg-slate-100 text-slate-400",
};

const VISIBILITY_STYLE: Record<string, string> = {
  public: "bg-emerald-50 text-emerald-600",
  unlisted: "bg-sky-50 text-sky-600",
  private: "bg-slate-50 text-slate-500",
};

export default async function DashboardPage() {
  const { auth, org, canEdit } = await requirePageAuth();

  // Reaching the dashboard is the end of first-run: mark onboarding done so a
  // user who left the wizard by any route (nav, back button) isn't sent back
  // to /onboarding on their next login. Idempotent — a no-op once set.
  if (auth.userId) {
    const { markOnboardingDone } = await import("@/lib/activation");
    await markOnboardingDone(auth.userId);
  }

  const { items: competitions } = await listCompetitions(auth, { cursor: null, limit: 100 });

  return (
    <>
      <Nav />
      <BillingBanner orgId={org.id} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                Competitions
              </h1>
              <span className={`badge ${roleBadge(org.role)}`}>{org.role}</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {canEdit
                ? "A competition holds one or more divisions — each with its own sport, entrants and format."
                : "You have view-only access to this board."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/directory" className="btn btn-ghost">
              Directory
            </Link>
            {canEdit && (
              <Link href="/competitions/new" data-tour="new-competition" className="btn btn-primary">
                + New Competition
              </Link>
            )}
          </div>
        </div>

        {competitions.length === 0 ? (
          canEdit ? (
            <div className="mt-12 flex flex-col items-center gap-6 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-purple-100">
                <Trophy className="h-8 w-8 text-purple-500" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-800">
                  No competitions yet
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Create your first competition, add a division for your sport,
                  register entrants and you&apos;re live.
                </p>
              </div>
              <Link href="/competitions/new" className="btn btn-primary">
                + New Competition
              </Link>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No competitions yet.</p>
          )
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {competitions.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/competitions/${c.id}`}
                  className="group block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-purple-300 hover:shadow"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="block truncate text-sm font-semibold text-slate-800 group-hover:text-purple-700">
                      {c.name}
                    </span>
                    <span className={`badge shrink-0 ${STATUS_STYLE[c.status] ?? STATUS_STYLE.draft}`}>
                      {c.frozen ? "frozen" : c.status}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                    {c.description ?? "—"}
                  </p>
                  <div className="mt-3 flex items-center gap-2 text-[11px]">
                    <span className={`badge ${VISIBILITY_STYLE[c.visibility] ?? VISIBILITY_STYLE.private}`}>
                      {c.visibility}
                    </span>
                    <span className="font-mono text-slate-400">{c.slug}</span>
                    {c.starts_on && (
                      <span className="text-slate-400">
                        {c.starts_on}
                        {c.ends_on ? ` → ${c.ends_on}` : ""}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function roleBadge(role: string): string {
  if (role === "owner") return "bg-amber-100 text-amber-700";
  if (role === "admin") return "bg-purple-100 text-purple-700";
  return "bg-slate-100 text-slate-600";
}

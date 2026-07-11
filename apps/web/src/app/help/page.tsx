import Link from "next/link";
import {
  ArrowRight, CalendarClock, ClipboardList, CreditCard, LayoutGrid,
  Megaphone, Play, Rocket, Trophy, Users, Webhook,
} from "lucide-react";
import { helpNav } from "@/server/help-content";
import { HelpSearch } from "@/components/help-search";

export const revalidate = 3600;

const SECTION_ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  "getting-started": Rocket,
  formats: LayoutGrid,
  entrants: Users,
  registration: ClipboardList,
  scheduling: CalendarClock,
  scoring: Play,
  divisions: Trophy,
  sharing: Megaphone,
  billing: CreditCard,
  api: Webhook,
};

export default function HelpIndexPage() {
  const nav = helpNav();
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-purple-600">
        Help centre
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        From setup to trophy — how everything works
      </h1>
      <p className="mt-3 max-w-2xl text-slate-600">
        Written for organisers, not engineers. Start with the seven-step
        series if you're new; search if you're stuck on something specific.
      </p>

      <div className="mt-6 max-w-xl">
        <HelpSearch />
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {nav.map((section) => {
          const Icon = SECTION_ICONS[section.section] ?? LayoutGrid;
          return (
            <section
              key={section.section}
              className="rounded-2xl border border-slate-200 p-5 transition hover:border-purple-200"
            >
              <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                <Icon className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
                {section.label}
              </h2>
              <ul className="mt-3 space-y-1.5 text-sm">
                {section.articles.map((a) => (
                  <li key={a.slug}>
                    <Link
                      href={`/help/${a.slug}`}
                      className="group inline-flex items-center gap-1 text-slate-600 transition hover:text-purple-700"
                    >
                      {a.title}
                      <ArrowRight
                        aria-hidden
                        className="h-3 w-3 text-transparent transition group-hover:text-purple-400"
                        strokeWidth={2}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <section className="rounded-2xl border border-slate-200 p-5 transition hover:border-purple-200">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900">
            <LayoutGrid className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
            Formats
          </h2>
          <p className="mt-3 text-sm text-slate-600">
            League, knockout, groups, swiss, americano… every format explained
            with a diagram and a live example.
          </p>
          <Link
            href="/help/formats"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-purple-700 hover:underline"
          >
            Open the format gallery <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
          </Link>
        </section>
      </div>

      <p className="mt-10 rounded-2xl bg-purple-50/60 p-5 text-sm text-slate-600">
        Can't find it? Email{" "}
        <a href="mailto:support@seazn.club" className="font-medium text-purple-700 underline">
          support@seazn.club
        </a>{" "}
        — real answers from the people who build this.
      </p>
    </div>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { helpNav } from "@/server/help-content";

export const metadata: Metadata = {
  title: { default: "Help centre — Seazn Club", template: "%s — Seazn Club Help" },
  description:
    "How to run tournaments and leagues on seazn.club — setup, registration, scheduling, scoring, sharing and billing, in plain words.",
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  const nav = helpNav();
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingNav />
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 lg:grid lg:grid-cols-[220px_1fr] lg:gap-10">
        <aside className="mb-8 lg:mb-0">
          <Link
            href="/help"
            className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-purple-700"
          >
            Help centre
          </Link>
          <nav aria-label="Help sections" className="mt-4 space-y-5 text-sm">
            {nav.map((section) => (
              <div key={section.section}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {section.label}
                </p>
                <ul className="space-y-1 border-l border-purple-100">
                  {section.articles.map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`/help/${a.slug}`}
                        className="-ml-px block border-l-2 border-transparent py-0.5 pl-3 text-slate-600 transition hover:border-purple-300 hover:text-purple-800"
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Formats
              </p>
              <ul className="space-y-1 border-l border-purple-100">
                <li>
                  <Link
                    href="/help/formats"
                    className="-ml-px block border-l-2 border-transparent py-0.5 pl-3 text-slate-600 transition hover:border-purple-300 hover:text-purple-800"
                  >
                    Format gallery
                  </Link>
                </li>
              </ul>
            </div>
          </nav>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
      <MarketingFooter />
    </div>
  );
}

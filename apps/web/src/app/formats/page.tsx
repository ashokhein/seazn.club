// Marketing /formats (v3/06 §4): the SEO landing for high-intent format
// queries ("round robin generator", "americano tournament format") — the
// same gallery as /help/formats wearing the marketing chrome, ending in the
// sign-up CTA.
import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { FORMAT_FAMILIES, FormatDiagram } from "@/config/format-gallery";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Tournament formats — round robin, knockout, groups, swiss, americano | Seazn Club",
  description:
    "Every tournament format explained — round robin leagues, knockout brackets, groups + knockout, swiss, double elimination, americano and ladders — with diagrams, real examples and a free generator.",
};

export default function FormatsMarketingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-purple-600">
          Tournament formats
        </p>
        <h1 className="mt-2 max-w-2xl text-4xl font-bold tracking-tight text-slate-900">
          Every format, explained — then generated for you
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Round robin, knockout, groups, swiss, americano — pick a shape below
          to see how it works, then let seazn.club build the fixtures, run the
          scoring and share the live standings.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {FORMAT_FAMILIES.map((f) => (
            <Link
              key={f.slug}
              href={`/help/formats/${f.slug}`}
              className="group rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md"
            >
              <div aria-hidden className="mb-3">
                <FormatDiagram slug={f.slug} />
              </div>
              <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
                {f.title}
                <ArrowRight
                  className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                  strokeWidth={2}
                />
              </h2>
              <p className="mt-1 text-sm text-slate-600">{f.tagline}</p>
            </Link>
          ))}
        </div>

        <div className="mt-12 rounded-2xl bg-court p-8 text-center text-court-ink">
          <h2 className="font-display text-2xl font-bold uppercase tracking-wide">
            Stop drawing brackets by hand
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm opacity-80">
            Pick a format, paste your entrants, and the fixtures, scoring and
            live standings are done. Free for small clubs.
          </p>
          <Link
            href="/login?tab=signup"
            className="mt-5 inline-block rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-purple-700 shadow transition hover:bg-purple-50"
          >
            Start free
          </Link>
        </div>
      </main>
      </MarketingShell>
    </div>
  );
}

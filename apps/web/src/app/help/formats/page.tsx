import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { FORMAT_FAMILIES, FormatDiagram } from "@/config/format-gallery";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Format gallery",
  description:
    "League, knockout, groups, swiss, double elimination, americano, ladder — every tournament format explained with a diagram and a live example.",
};

export default function FormatGalleryPage() {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-purple-600">
        Format gallery
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
        Pick the right shape for your day
      </h1>
      <p className="mt-3 max-w-2xl text-slate-600">
        Every format the engine speaks, explained the same way: what it is, who
        it suits, the trade-off — with a diagram and a real generated example.
      </p>

      <ul className="mt-8 space-y-4">
        {FORMAT_FAMILIES.map((f) => (
          <li key={f.slug}>
            <Link
              href={`/help/formats/${f.slug}`}
              className="group grid gap-4 rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md sm:grid-cols-[1fr_260px] sm:items-center"
            >
              <div>
                <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
                  {f.title}
                  {f.pro ? (
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                      Pro
                    </span>
                  ) : null}
                  <ArrowRight
                    className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                    strokeWidth={2}
                  />
                </h2>
                <p className="mt-1 text-sm text-slate-600">{f.tagline}</p>
                <p className="mt-2 text-xs text-slate-500">{f.bestFor}</p>
              </div>
              <div aria-hidden className="hidden sm:block">
                <FormatDiagram slug={f.slug} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

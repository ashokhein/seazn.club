import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { FORMAT_FAMILIES, FormatDiagram, familyCopy } from "@/config/format-gallery";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "formats.meta.title"),
    description: t(d, "formats.meta.description"),
    alternates: {
      canonical: `/${lang}/formats`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/formats`])),
        "x-default": "/en/formats",
      },
    },
  };
}

export default async function FormatsMarketingPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [d, ui] = await Promise.all([
    getDictionary(lang, "marketing"),
    getDictionary(lang, "ui"),
  ]);
  const tf = (key: string) => t(ui, key);
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell lang={lang}>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <p className="mk-eyebrow">
          {t(d, "formats.eyebrow")}
        </p>
        <h1 className="mk-display mt-3 max-w-2xl text-5xl font-bold text-purple-950">
          {t(d, "formats.h1")}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          {t(d, "formats.subhead")}
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {FORMAT_FAMILIES.map((f) => {
            const copy = familyCopy(f, tf);
            return (
              <Link
                key={f.slug}
                href={`/help/formats/${f.slug}`}
                className="group rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md"
              >
                <div aria-hidden className="mb-3">
                  <FormatDiagram slug={f.slug} />
                </div>
                <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
                  {copy.title}
                  <ArrowRight
                    className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                    strokeWidth={2}
                  />
                </h2>
                <p className="mt-1 text-sm text-slate-600">{copy.tagline}</p>
              </Link>
            );
          })}
        </div>

        <div className="mt-12 rounded-2xl bg-[linear-gradient(160deg,var(--mk-night-2),var(--mk-night))] p-8 text-center text-[var(--mk-cream)]">
          <h2 className="mk-display text-3xl font-bold">
            {t(d, "formats.cta.title")}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm opacity-80">
            {t(d, "formats.cta.body")}
          </p>
          <Link
            href="/login?tab=signup"
            className="mk-display mt-5 inline-block rounded-xl bg-[var(--mk-lime)] px-6 py-2.5 text-sm font-bold text-[var(--mk-night)] transition hover:opacity-90"
          >
            {t(d, "formats.cta.button")}
          </Link>
        </div>
      </main>
      </MarketingShell>
    </div>
  );
}

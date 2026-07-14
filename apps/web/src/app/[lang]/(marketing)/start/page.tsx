import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { StartWizard } from "@/components/start-wizard";
import { LOCALES, hasLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang, "marketing");
  return {
    title: t(dict, "start.meta.title"),
    description: t(dict, "start.meta.description"),
    alternates: {
      canonical: `/${lang}/start`,
      // hreflang alternates — the primary SEO signal for the localized surface.
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}/start`])),
        "x-default": "/en/start",
      },
    },
  };
}

/** No-auth funnel wizard (v3/07 §6): the visitor invests first — the emailed
 *  claim link signs them in and creates everything they configured here. */
export default async function StartPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ sport?: string; entrants?: string; date?: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang, "marketing");
  const sp = await searchParams;
  const entrants = Number(sp.entrants);
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-xl px-4 py-12">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-purple-900">
            {t(dict, "start.heading")}
          </h1>
          <p className="mt-2 text-slate-500">{t(dict, "start.subhead")}</p>
        </div>
        <StartWizard
          initial={{
            sport: sp.sport,
            entrants: Number.isFinite(entrants) && entrants >= 2 ? entrants : undefined,
            date: sp.date,
          }}
        />
      </main>
      <MarketingFooter />
    </>
  );
}

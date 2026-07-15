import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

// Emoji are data, not copy — kept here rather than in the translated catalog.
const ICONS: Record<string, string[]> = {
  clubs: ["🗓️", "⚡", "👥", "🏅", "🖨️", "🔁"],
  events: ["🚀", "📱", "🎯", "🏆", "📊", "🖨️"],
  schools: ["🏫", "📱", "🗓️", "🎓", "🖨️", "👨‍🏫"],
};
const CASES = Object.keys(ICONS);

export function generateStaticParams() {
  return CASES.map((c) => ({ case: c }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; case: string }>;
}): Promise<Metadata> {
  const { lang, case: kase } = await params;
  if (!hasLocale(lang) || !ICONS[kase]) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, `useCases.${kase}.metaTitle`),
    description: t(d, `useCases.${kase}.metaDesc`),
    alternates: {
      canonical: `/${lang}/use-cases/${kase}`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/use-cases/${kase}`])),
        "x-default": `/en/use-cases/${kase}`,
      },
    },
  };
}

export default async function UseCasePage({
  params,
}: {
  params: Promise<{ lang: string; case: string }>;
}) {
  const { lang, case: kase } = await params;
  if (!hasLocale(lang) || !ICONS[kase]) notFound();
  const d = await getDictionary(lang, "marketing");
  const icons = ICONS[kase];

  return (
    <>
      <MarketingShell lang={lang}>
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16">
          <div className="mk-display mb-4 inline-flex items-center gap-2 rounded-full bg-[var(--mk-lime)] px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[var(--mk-night)]">
            {t(d, `useCases.${kase}.badge`)}
          </div>
          <h1 className="mk-display mb-4 text-5xl font-bold text-purple-950 sm:text-6xl">
            {t(d, `useCases.${kase}.h1`)}
          </h1>
          <p className="mb-8 max-w-2xl text-lg text-slate-600">
            {t(d, `useCases.${kase}.subhead`)}
          </p>

          <div className="grid gap-6 sm:grid-cols-2">
            {icons.map((icon, i) => (
              <div key={i} className="card p-6">
                <div className="mb-3 text-3xl">{icon}</div>
                <h3 className="mb-1 font-semibold text-slate-800">{t(d, `useCases.${kase}.card.${i}.title`)}</h3>
                <p className="text-sm text-slate-500">{t(d, `useCases.${kase}.card.${i}.body`)}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-purple-50 py-14 text-center">
          <h2 className="mb-3 text-2xl font-bold text-purple-900">
            {t(d, `useCases.${kase}.cta.title`)}
          </h2>
          <p className="mb-6 text-slate-500">{t(d, `useCases.${kase}.cta.subtext`)}</p>
          <Link href="/login?tab=signup" className="btn btn-primary px-8 py-3 text-base">
            {t(d, "useCases.startFree")} →
          </Link>
        </section>
      </main>
      </MarketingShell>
    </>
  );
}

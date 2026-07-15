import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { LiveWall } from "@/components/marketing/live-wall";
import { LiveRefresh } from "@/components/marketing/live-refresh";
import { getDiscoveryLiveAll } from "@/server/public-site/discovery";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

// The wall stays fresh on its own: 30s ISR + a visibility-aware client
// refresh (LiveRefresh) for parked tabs.
export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "live.meta.title"),
    description: t(d, "live.meta.description"),
    alternates: {
      canonical: `/${lang}/live`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/live`])),
        "x-default": "/en/live",
      },
    },
  };
}

export default async function LivePage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [d, fixtures] = await Promise.all([
    getDictionary(lang, "marketing"),
    getDiscoveryLiveAll().catch(() => []),
  ]);

  return (
    <MarketingShell>
      <main className="bg-[var(--mk-light-warm)]">
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-12">
          <p className="mk-eyebrow">{t(d, "live.eyebrow")}</p>
          <h1 className="mk-display mt-2 text-5xl font-bold text-purple-950">{t(d, "live.h1")}</h1>
          <p className="mt-3 max-w-xl text-slate-600">
            {t(d, "live.subhead")}
          </p>

          <div className="mt-8">
            <LiveWall fixtures={fixtures} />
          </div>

          <p className="mt-6 text-sm text-slate-600">
            {t(d, "live.browsePre")}{" "}
            <Link href="/discover" className="font-medium text-purple-700 underline underline-offset-2">
              {t(d, "live.browseLink")}
            </Link>
            . {t(d, "live.startPre")}{" "}
            <Link href={`/${lang}/start`} className="font-medium text-purple-700 underline underline-offset-2">
              {t(d, "live.startLink")}
            </Link>
            .
          </p>
        </section>
      </main>
      <LiveRefresh />
    </MarketingShell>
  );
}

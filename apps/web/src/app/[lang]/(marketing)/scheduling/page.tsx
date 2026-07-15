import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SchedulingBoard } from "@/components/marketing/scheduling-board";
import { Reveal } from "@/components/marketing/reveal";
import { notFound } from "next/navigation";
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
    title: t(d, "scheduling.meta.title"),
    description: t(d, "scheduling.meta.description"),
    alternates: {
      canonical: `/${lang}/scheduling`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/scheduling`])),
        "x-default": "/en/scheduling",
      },
    },
  };
}

// Time is data; what/how copy resolves from the marketing catalog per locale.
const RUNDOWN = [
  { time: "08:40", key: "build" },
  { time: "08:55", key: "clash" },
  { time: "09:00", key: "publish" },
  { time: "12:30", key: "rain" },
] as const;

const KIT = ["print", "scorer", "live"] as const;

export default async function SchedulingPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  return (
    <MarketingShell>
      <main className="bg-[var(--mk-light-warm)]">
        <section className="mx-auto max-w-4xl px-4 pb-14 pt-16">
          <h1 className="mk-display text-5xl font-bold text-purple-950">{t(d, "scheduling.hero.title")}</h1>
          <p className="mt-3 max-w-xl text-slate-600">
            {t(d, "scheduling.hero.subhead")}
          </p>
          <div className="mt-8">
            <SchedulingBoard />
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-14">
          <h2 className="mk-display mb-6 text-3xl font-bold text-purple-950">{t(d, "scheduling.orderOfPlay")}</h2>
          <div className="border-l-2 border-purple-950 pl-5">
            {RUNDOWN.map((r) => (
              <Reveal
                key={r.time}
                className="flex items-baseline gap-4 border-b border-dashed border-[#e5decd] py-2.5"
              >
                <span className="mk-display min-w-14 text-lg font-bold tabular-nums text-[var(--mk-purple)]">
                  {r.time}
                </span>
                <span>
                  <span className="text-sm font-semibold text-slate-800">{t(d, `scheduling.rundown.${r.key}.what`)}</span>{" "}
                  <span className="text-sm text-slate-600">— {t(d, `scheduling.rundown.${r.key}.how`)}</span>
                </span>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-20">
          <div className="grid gap-4 sm:grid-cols-3">
            {KIT.map((k) => (
              <div key={k} className="card p-4 text-sm">
                <p className="mb-1 font-semibold text-slate-800">{t(d, `scheduling.kit.${k}.label`)}</p>
                <p className="text-slate-500">{t(d, `scheduling.kit.${k}.body`)}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center">
            <Link href={`/${lang}/start`} className="btn btn-primary px-6 py-2.5 text-base">
              {t(d, "scheduling.cta")} →
            </Link>
          </p>
        </section>
      </main>
    </MarketingShell>
  );
}

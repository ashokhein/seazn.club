import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { StartWizard } from "@/components/start-wizard";

export const metadata: Metadata = {
  title: "Start a competition — Seazn Club",
  description:
    "Name your competition, get a format recommendation, and go live — in about 60 seconds, before you even sign up.",
};

/** No-auth funnel wizard (v3/07 §6): the visitor invests first — the emailed
 *  claim link signs them in and creates everything they configured here. */
export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; entrants?: string; date?: string }>;
}) {
  const sp = await searchParams;
  const entrants = Number(sp.entrants);
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-xl px-4 py-12">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-purple-900">
            Start your competition
          </h1>
          <p className="mt-2 text-slate-500">
            Sixty seconds, no account needed — we’ll email you the keys.
          </p>
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

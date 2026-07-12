import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { LiveWall } from "@/components/marketing/live-wall";
import { LiveRefresh } from "@/components/marketing/live-refresh";
import { getDiscoveryLiveAll } from "@/server/public-site/discovery";

export const metadata: Metadata = {
  title: "Live now",
  description:
    "Every public match being scored on Seazn Club right now — live scores from clubs, leagues and one-day events.",
};

// The wall stays fresh on its own: 30s ISR + a visibility-aware client
// refresh (LiveRefresh) for parked tabs.
export const revalidate = 30;

export default async function LivePage() {
  const fixtures = await getDiscoveryLiveAll().catch(() => []);

  return (
    <MarketingShell>
      <main className="bg-[var(--mk-light-warm)]">
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-12">
          <p className="mk-eyebrow">Under the floodlights</p>
          <h1 className="mk-display mt-2 text-5xl font-bold text-purple-950">Live now</h1>
          <p className="mt-3 max-w-xl text-slate-600">
            Every public match being scored on Seazn Club at this moment —
            straight from courtside phones. Scores update by themselves.
          </p>

          <div className="mt-8">
            <LiveWall fixtures={fixtures} />
          </div>

          <p className="mt-6 text-sm text-slate-600">
            Looking for a whole competition, not one match?{" "}
            <Link href="/discover" className="font-medium text-purple-700 underline underline-offset-2">
              Browse the directory
            </Link>
            . Want your club up here?{" "}
            <Link href="/start" className="font-medium text-purple-700 underline underline-offset-2">
              Start free
            </Link>
            .
          </p>
        </section>
      </main>
      <LiveRefresh />
    </MarketingShell>
  );
}

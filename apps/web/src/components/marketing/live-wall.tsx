// The /live floodlit wall — every discoverable in-play fixture as a scorebug
// card on one night slab. Server-rendered from public_discovery_v data only;
// real fixtures or an honest empty state, never filler.
import Link from "next/link";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";
import { sportEmoji } from "@/components/discovery-cards";

export function LiveWall({ fixtures }: { fixtures: DiscoveryLiveFixture[] }) {
  return (
    <section
      aria-label="Live matches"
      className="app-night-stage rounded-3xl p-5 sm:p-8"
    >
      {fixtures.length === 0 ? (
        <div className="py-16 text-center">
          <p className="mk-display text-2xl font-bold text-cream">
            No one&apos;s under the floodlights right now
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm text-cream/60">
            Public matches appear here the moment a scorer records the first
            point. Check what&apos;s coming up instead — or put your own club
            on this wall.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/discover"
              className="btn bg-lime-400 font-semibold text-night hover:bg-lime-300"
            >
              This week&apos;s competitions
            </Link>
            <Link
              href="/start"
              className="btn border border-cream/25 text-cream hover:bg-cream/10"
            >
              Run your own
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-lime-400">
            <span className="chip-pulse-dot h-2 w-2 rounded-full bg-lime-400" aria-hidden />
            {fixtures.length} live now
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fixtures.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/shared/${f.org_slug}/${f.comp_slug}/${f.division_slug}/fixtures/${f.id}`}
                  className="block rounded-2xl border border-cream/10 bg-cream/[0.05] p-4 transition hover:border-lime-400/50 hover:bg-cream/10"
                >
                  <p className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-cream/50">
                    <span aria-hidden>{sportEmoji(f.sport_key)}</span>
                    <span className="truncate">{f.competition_name}</span>
                  </p>
                  <p className="mk-display mt-2 flex items-center gap-2 truncate text-xl font-bold tabular-nums text-cream">
                    <span className="truncate">{f.headline ?? "In play"}</span>
                    {f.strength ? (
                      <span className="shrink-0 rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-300">
                        {f.strength}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-2 text-xs font-medium text-lime-400">
                    Watch live →
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

import Link from "next/link";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

/** LIVE ticker under the hero (design/v3/12 §4.3). Real fixtures only —
 *  collapses when nothing is live. Marquee duplicates the row for a seamless
 *  loop; it pauses on hover/focus and is static under reduced motion. */
export function LiveTicker({ fixtures }: { fixtures: DiscoveryLiveFixture[] }) {
  if (fixtures.length === 0) return null;

  const row = (dup: boolean) => (
    <div className="flex shrink-0 items-center gap-8 pr-8" aria-hidden={dup}>
      {fixtures.map((f) => (
        <Link
          key={`${dup ? "d-" : ""}${f.id}`}
          href={`/shared/${f.org_slug}/${f.comp_slug}/${f.division_slug}/fixtures/${f.id}`}
          tabIndex={dup ? -1 : 0}
          className="mk-display flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-[var(--mk-night)]"
        >
          <span className="h-2 w-2 rounded-full bg-[var(--mk-live)]" aria-hidden />
          {f.headline ?? f.competition_name}
          <span className="font-normal opacity-70">· {f.competition_name}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <section aria-label="Live right now" className="relative overflow-hidden bg-[var(--mk-lime)] py-2.5">
      <div className="mk-ticker flex w-max">
        {row(false)}
        {row(true)}
      </div>
      {/* The strip shows at most 6 (getDiscoveryLive's cap) — the wall at
          /live holds the rest, so a busy Saturday never floods the home. */}
      <Link
        href="/live"
        className="mk-display absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-[var(--mk-lime)] via-[var(--mk-lime)] to-transparent pl-10 pr-4 text-sm font-bold text-[var(--mk-night)]"
      >
        All live →
      </Link>
    </section>
  );
}

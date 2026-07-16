// The /live floodlit wall — every discoverable in-play fixture as a scorebug
// card on one night slab. Server-rendered from public_discovery_v data only;
// real fixtures or an honest empty state, never filler.
import Link from "next/link";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";
import { sportEmoji } from "@/components/discovery-cards";
import { t, type Dict } from "@/lib/i18n";
import { plural } from "@/lib/i18n-runtime";
import type { Locale } from "@/lib/i18n-constants";

export function LiveWall({
  fixtures,
  dict,
  lang,
}: {
  fixtures: DiscoveryLiveFixture[];
  dict: Dict;
  lang: Locale;
}) {
  return (
    <section
      aria-label={t(dict, "live.wall.aria")}
      className="app-night-stage rounded-3xl p-5 sm:p-8"
    >
      {fixtures.length === 0 ? (
        <div className="py-16 text-center">
          <p className="mk-display text-2xl font-bold text-cream">
            {t(dict, "live.wall.emptyTitle")}
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm text-cream/60">
            {t(dict, "live.wall.emptyBody")}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href={`/${lang}/discover`}
              className="btn bg-lime-400 font-semibold text-night hover:bg-lime-300"
            >
              {t(dict, "live.wall.emptyDiscover")}
            </Link>
            <Link
              href={`/${lang}/start`}
              className="btn border border-cream/25 text-cream hover:bg-cream/10"
            >
              {t(dict, "live.wall.emptyStart")}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-lime-400">
            <span className="chip-pulse-dot h-2 w-2 rounded-full bg-lime-400" aria-hidden />
            {plural(dict, "live.wall.count", fixtures.length, lang)}
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
                    <span className="truncate">{f.headline ?? t(dict, "discovery.inPlay")}</span>
                    {f.strength ? (
                      <span className="shrink-0 rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-300">
                        {f.strength}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-2 text-xs font-medium text-lime-400">
                    {t(dict, "live.wall.watch")}
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

// /discover — the public tournament directory (doc 15 §2, PROMPT-19).
// Server Component on public_discovery_v only, cached under the `discovery`
// ISR tag. Filters travel as query params so the page stays cacheable per
// filter combination.
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  getDiscoveryDirectory,
  listDiscoverySports,
} from "@/server/public-site/discovery";
import { DiscoveryCard, sportEmoji } from "@/components/discovery-cards";

export const metadata: Metadata = {
  title: "Discover live tournaments — Seazn Club",
  description:
    "Live and upcoming community tournaments running on Seazn Club — cricket, football, volleyball, chess, carrom and more. Follow live scores, or run your own.",
  alternates: { canonical: "https://seazn.club/discover" },
};

interface SearchParams {
  sport?: string;
  country?: string;
  status?: string;
  q?: string;
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status: "live" | "upcoming" | undefined =
    params.status === "live" || params.status === "upcoming" ? params.status : undefined;
  const filters = {
    sport: params.sport || undefined,
    country: params.country || undefined,
    status,
    q: params.q || undefined,
  };
  const [entries, sports] = await Promise.all([
    getDiscoveryDirectory(filters).catch(() => []),
    listDiscoverySports().catch(() => []),
  ]);

  return (
    <>
      <MarketingShell>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mk-display text-4xl font-bold text-purple-950">
          Discover tournaments
        </h1>
        <p className="mt-2 max-w-xl text-slate-600">
          Live and upcoming competitions run by clubs on Seazn Club. Every one
          of them set up in minutes — yours could be here too.
        </p>

        {/* Sport chips + status filter (plain links — cacheable). */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <FilterChip href="/discover" active={!filters.sport && !status} label="All" />
          {sports.map((s) => (
            <FilterChip
              key={s.key}
              href={`/discover/${s.key}`}
              active={filters.sport === s.key}
              label={`${sportEmoji(s.key)} ${s.name}`}
            />
          ))}
          <span className="mx-2 hidden h-4 w-px bg-slate-200 sm:block" />
          <FilterChip
            href={withParam(filters, "status", "live")}
            active={status === "live"}
            label="🔴 Live"
          />
          <FilterChip
            href={withParam(filters, "status", "upcoming")}
            active={status === "upcoming"}
            label="Upcoming"
          />
        </div>

        {/* Search (GET form — lands back here with ?q=). */}
        <form method="get" action="/discover" className="mt-4 flex max-w-md gap-2">
          {filters.sport && <input type="hidden" name="sport" value={filters.sport} />}
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Search by name or club…"
            className="input flex-1"
          />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>

        {entries.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-slate-500">No tournaments match right now.</p>
            <Link href="/login?tab=signup" className="btn btn-primary mt-4 inline-flex">
              Run your own →
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e) => (
              <DiscoveryCard key={e.id} entry={e} withJsonLd />
            ))}
          </div>
        )}

        {/* Acquisition loop (doc 15): spectator → organiser. */}
        <section className="mt-16 rounded-xl bg-purple-900 p-8 text-center text-white">
          <h2 className="text-xl font-bold">Run your own tournament</h2>
          <p className="mt-1 text-sm text-purple-200">
            Any sport, any format — free for community clubs.
          </p>
          <Link
            href="/login?tab=signup"
            className="btn mt-4 inline-flex bg-white px-6 font-semibold text-purple-900 hover:bg-purple-50"
          >
            Start free →
          </Link>
        </section>
      </main>
      </MarketingShell>
    </>
  );
}

function withParam(filters: SearchParams, key: string, value: string): string {
  const p = new URLSearchParams();
  if (filters.sport) p.set("sport", filters.sport);
  if (filters.q) p.set("q", filters.q);
  if (filters.country) p.set("country", filters.country);
  if (filters.status === value) p.delete(key);
  else p.set(key, value);
  const qs = p.toString();
  return qs ? `/discover?${qs}` : "/discover";
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-full bg-purple-600 px-3 py-1 text-xs font-medium text-white"
          : "chip hover:border-purple-300"
      }
    >
      {label}
    </Link>
  );
}

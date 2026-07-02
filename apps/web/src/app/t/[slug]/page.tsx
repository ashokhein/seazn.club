import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { sql } from "@/lib/db";
import { computeStandings } from "@/lib/standings";
import { loadBundle } from "@/lib/tournament";
import { hasFeature } from "@/lib/entitlements";
import { MarketingNav } from "@/components/marketing-nav";
import { PublicTournamentView } from "@/components/public-tournament-view";
import type { Tournament } from "@/lib/types";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [t] = await sql<Pick<Tournament, "id" | "name" | "sport">[]>`
    select id, name, sport from tournaments
    where public_slug = ${slug} and is_public = true limit 1`;
  if (!t) return { title: "Tournament not found — Seazn Club" };
  return {
    title: `${t.name} — Seazn Club`,
    description: `Live standings and bracket for ${t.name} (${t.sport}).`,
  };
}

export default async function PublicTournamentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [t] = await sql<(Tournament & { org_id: string }& { is_public: boolean })[]>`
    select * from tournaments
    where public_slug = ${slug} and is_public = true limit 1`;
  if (!t) notFound();

  const bundle = await loadBundle(t.id);
  if (!bundle) notFound();

  const standings = computeStandings(
    bundle.players,
    bundle.rounds,
    bundle.matches,
    {
      points_win: t.points_win,
      points_draw: t.points_draw,
      points_loss: t.points_loss,
      use_progress_score: t.use_progress_score,
    },
  );

  // Pro orgs: no "Powered by" badge; may have org logo
  const [isPro, [org]] = await Promise.all([
    hasFeature(t.org_id, "branding").catch(() => false),
    sql<{ name: string; logo_url: string | null; logo_storage_path: string | null }[]>`
      select name, logo_url, logo_storage_path from organizations where id = ${t.org_id}`,
  ]);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const orgLogoUrl = org?.logo_storage_path && supabaseUrl
    ? `${supabaseUrl}/storage/v1/object/public/assets/${org.logo_storage_path}`
    : (org?.logo_url?.startsWith("https://") ? org.logo_url : null);

  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-start gap-4">
          {isPro && orgLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={orgLogoUrl} alt={org?.name ?? "Org logo"} className="h-12 w-12 rounded-xl object-cover shadow-sm" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-purple-900">{t.name}</h1>
            <p className="text-sm text-slate-500">
              {t.sport} · {t.category} · {t.format.replace(/_/g, " ")}
              {isPro && org?.name ? ` · ${org.name}` : ""}
            </p>
          </div>
        </div>
        <PublicTournamentView state={{ ...bundle, standings }} />
      </main>
      {!isPro && (
        <div className="border-t border-purple-100 bg-purple-50 py-3 text-center text-xs text-slate-500">
          Powered by{" "}
          <Link href="/" className="font-semibold text-purple-700 hover:underline">
            Seazn Club
          </Link>{" "}
          — free for community clubs
        </div>
      )}
    </>
  );
}

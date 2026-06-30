import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { loadBundle } from "@/lib/tournament";
import { computeStandings } from "@/lib/standings";
import { SlideshowView } from "@/components/slideshow-view";
import type { Organization, TournamentState } from "@/lib/types";

export default async function SlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await loadBundle(id);
  if (!bundle) notFound();
  const t = bundle.tournament;

  const [org] = await sql<Pick<Organization, "logo_url" | "logo_storage_path">[]>`
    select logo_url, logo_storage_path from organizations where id = ${t.org_id}`;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const orgLogoUrl = org?.logo_storage_path
    ? `${supabaseUrl}/storage/v1/object/public/assets/${org.logo_storage_path}`
    : (org?.logo_url ?? null);

  const standings = computeStandings(bundle.players, bundle.rounds, bundle.matches, {
    points_win: t.points_win,
    points_draw: t.points_draw,
    points_loss: t.points_loss,
    use_progress_score: t.use_progress_score,
  });
  const initial: TournamentState = { ...bundle, standings };
  return <SlideshowView id={id} initial={initial} orgLogoUrl={orgLogoUrl} />;
}

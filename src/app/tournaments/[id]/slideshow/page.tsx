import { notFound } from "next/navigation";
import { loadBundle } from "@/lib/tournament";
import { computeStandings } from "@/lib/standings";
import { SlideshowView } from "@/components/slideshow-view";
import type { TournamentState } from "@/lib/types";

export default async function SlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await loadBundle(id);
  if (!bundle) notFound();
  const t = bundle.tournament;
  const standings = computeStandings(bundle.players, bundle.rounds, bundle.matches, {
    points_win: t.points_win,
    points_draw: t.points_draw,
    points_loss: t.points_loss,
    use_progress_score: t.use_progress_score,
  });
  const initial: TournamentState = { ...bundle, standings };
  return <SlideshowView id={id} initial={initial} />;
}

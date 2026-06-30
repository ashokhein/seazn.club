import { notFound } from "next/navigation";
import { getCurrentUser, getOrgRole } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { LiveTournament } from "@/components/live-tournament";
import { loadBundle } from "@/lib/tournament";
import { computeStandings } from "@/lib/standings";

export default async function TournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, bundle] = await Promise.all([getCurrentUser(), loadBundle(id)]);
  if (!bundle) notFound();

  const t = bundle.tournament;
  // Only owners/admins of the owning org may edit; everyone else is read-only.
  const role = user ? await getOrgRole(t.org_id, user.id) : null;
  const canEdit = role === "owner" || role === "admin";
  const standings = computeStandings(bundle.players, bundle.rounds, bundle.matches, {
    points_win: t.points_win,
    points_draw: t.points_draw,
    points_loss: t.points_loss,
    use_progress_score: t.use_progress_score,
  });

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <LiveTournament
          id={id}
          canEdit={canEdit}
          initial={{ ...bundle, standings }}
        />
      </main>
    </>
  );
}

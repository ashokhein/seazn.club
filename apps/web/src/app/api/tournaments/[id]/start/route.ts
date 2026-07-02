import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { startTournament } from "@/lib/tournament";
import { trackEvent } from "@/lib/activation";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user, orgId } = await requireTournamentEditor(id);
    await startTournament(id, orgId, user.display_name);
    void trackEvent(user.id, orgId, "tournament_started", { tournament_id: id });
    return { started: true };
  });
}

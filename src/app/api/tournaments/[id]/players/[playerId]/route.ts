import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { removePlayer } from "@/lib/tournament";

/** Remove a player from a tournament that has not started yet. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; playerId: string }> },
) {
  return handler(async () => {
    const { id, playerId } = await params;
    const user = await requireTournamentEditor(id);
    await removePlayer(id, playerId, user.display_name);
    return { ok: true };
  });
}

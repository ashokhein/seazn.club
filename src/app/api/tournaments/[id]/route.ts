import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { deleteTournament } from "@/lib/tournament";

/** Delete a tournament that has not started yet (setup only). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { orgId } = await requireTournamentEditor(id);
    await deleteTournament(id, orgId);
    return { deleted: true };
  });
}

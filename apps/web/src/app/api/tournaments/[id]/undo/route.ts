import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { undoLast } from "@/lib/tournament";
import { publishTournamentUpdate } from "@/lib/realtime";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user, orgId } = await requireTournamentEditor(id);
    await undoLast(id, orgId, user.display_name);
    void publishTournamentUpdate(id, "undo");
    return { undone: true };
  });
}

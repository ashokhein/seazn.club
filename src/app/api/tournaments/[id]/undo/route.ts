import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { undoLast } from "@/lib/tournament";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const user = await requireTournamentEditor(id);
    await undoLast(id, user.display_name);
    return { undone: true };
  });
}

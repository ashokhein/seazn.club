import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { startTournament } from "@/lib/tournament";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const user = await requireTournamentEditor(id);
    await startTournament(id, user.display_name);
    return { started: true };
  });
}

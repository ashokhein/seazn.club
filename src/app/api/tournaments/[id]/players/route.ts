import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { addPlayers } from "@/lib/tournament";
import { addPlayersSchema } from "@/lib/types";

/** Add players to a tournament that has not started yet. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user, orgId } = await requireTournamentEditor(id);
    const { players } = addPlayersSchema.parse(await req.json());
    const added = await addPlayers(id, orgId, players, user.display_name);
    return { added };
  });
}

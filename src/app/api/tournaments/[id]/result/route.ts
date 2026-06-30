import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { loadState, recordResult } from "@/lib/tournament";
import { recordResultSchema } from "@/lib/types";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const user = await requireTournamentEditor(id);
    const body = recordResultSchema.parse(await req.json());
    await recordResult(
      id,
      body.match_id,
      {
        winner_id: body.winner_id ?? null,
        player1_score: body.player1_score ?? null,
        player2_score: body.player2_score ?? null,
        is_draw: body.is_draw,
      },
      user.display_name,
    );
    // Return the fresh state so the client updates instantly (no extra round-trip).
    return await loadState(id);
  });
}

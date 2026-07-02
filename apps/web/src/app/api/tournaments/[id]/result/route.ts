import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { loadState, recordResult } from "@/lib/tournament";
import { recordResultSchema } from "@/lib/types";
import { trackEvent } from "@/lib/activation";
import { publishTournamentUpdate } from "@/lib/realtime";
import { rateLimit, MUTATION_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`result:${ip}`, MUTATION_LIMIT);
    const { user, orgId } = await requireTournamentEditor(id);
    const body = recordResultSchema.parse(await req.json());
    await recordResult(
      id,
      orgId,
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
    const state = await loadState(id);
    void publishTournamentUpdate(id, "result");
    if (state?.tournament?.status === "completed") {
      void trackEvent(user.id, orgId, "tournament_completed", { tournament_id: id });
    }
    return state;
  });
}

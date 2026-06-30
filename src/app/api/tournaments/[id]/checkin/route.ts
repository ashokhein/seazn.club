import { requireTournamentEditor } from "@/lib/auth";
import { handler } from "@/lib/http";
import { setCheckIn } from "@/lib/tournament";
import { setCheckInSchema } from "@/lib/types";
import { publishTournamentUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user, orgId } = await requireTournamentEditor(id);
    const { player_id, checked_in } = setCheckInSchema.parse(await req.json());
    await setCheckIn(id, orgId, player_id, checked_in, user.display_name);
    void publishTournamentUpdate(id, "checkin");
    return { ok: true };
  });
}

import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { personStats } from "@/server/usecases/player-stats";

type Ctx = { params: Promise<{ id: string }> };

/** A player's card stats, keyed per division (Jul3/07 §6). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    const divisionId = new URL(req.url).searchParams.get("division_id") ?? undefined;
    return personStats(auth, id, divisionId);
  });
}

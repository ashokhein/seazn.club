import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionPlayerStats } from "@/server/usecases/player-stats";

type Ctx = { params: Promise<{ id: string }> };

/** Division leaderboard, sortable by any declared metric (Jul3/07 §6;
 *  Pro `stats.player`). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const url = new URL(req.url);
    const sort = url.searchParams.get("sort");
    return divisionPlayerStats(auth, id, {
      metric: url.searchParams.get("metric") ?? undefined,
      sort: sort === "asc" ? "asc" : "desc",
    });
  });
}

import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { syncEntrantRosterFromSquad } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/entrants/{id}/roster/sync — replace the entrant's roster with
 *  the linked team's current squad (enrollment snapshots once; this re-syncs). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    return syncEntrantRosterFromSquad(auth, id);
  });
}

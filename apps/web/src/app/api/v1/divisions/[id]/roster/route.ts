import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionRoster } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/divisions/{id}/roster — every (person → team entrant)
 *  membership in the division, for the same-division double-roster warning. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return divisionRoster(auth, id);
  });
}

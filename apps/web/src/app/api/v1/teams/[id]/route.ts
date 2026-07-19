import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchTeam } from "@/server/api-v1/schemas";
import { setTeamClub } from "@/server/usecases/teams";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/v1/teams/{id} — move a team into a club or detach it (club_id:
 *  null). Pro `clubs.hierarchy`. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchTeam);
    const auth = await requireResourceAuth(req, "team", id, "write");
    return setTeamClub(auth, id, body.club_id);
  });
}

import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { SetTeamSquad } from "@/server/api-v1/schemas";
import { getTeamSquad, setTeamSquad } from "@/server/usecases/teams";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/teams/{id}/squad — the team's persistent squad. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "team", id, "read");
    return getTeamSquad(auth, id);
  });
}

/** PUT /api/v1/teams/{id}/squad — full-replace the squad (Pro). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, SetTeamSquad);
    const auth = await requireResourceAuth(req, "team", id, "write");
    return setTeamSquad(auth, id, body.members);
  });
}

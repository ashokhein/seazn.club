import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateTeam } from "@/server/api-v1/schemas";
import { createTeam } from "@/server/usecases/teams";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/clubs/{id}/teams — create a team under a club (Pro). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateTeam);
    const auth = await requireResourceAuth(req, "club", id, "write");
    return reply(201, await createTeam(auth, id, body));
  });
}

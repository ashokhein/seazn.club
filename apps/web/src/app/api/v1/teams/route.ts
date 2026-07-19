import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreateTeamStandalone } from "@/server/api-v1/schemas";
import { listTeams, createTeam } from "@/server/usecases/teams";

/** GET /api/v1/teams — org teams with resolved club badge and the most-recent
 *  entrant id, for the enroll-an-existing-team picker. Ungated read. */
export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listTeams(auth);
  });
}

/** POST /api/v1/teams — create a team, optionally under a club (Pro
 *  `clubs.hierarchy`; cap-enforced). Standalone when club_id is omitted. */
export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, CreateTeamStandalone);
    const auth = await requireAuth(req, "write");
    return reply(201, await createTeam(auth, body));
  });
}

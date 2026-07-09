import { v1 } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { listTeams } from "@/server/usecases/teams";

/** GET /api/v1/teams — org teams with resolved club badge and the most-recent
 *  entrant id, for the enroll-an-existing-team picker. Ungated read. */
export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    return listTeams(auth);
  });
}

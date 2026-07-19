import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { fixtureReports } from "@/server/usecases/match-reports";

type Ctx = { params: Promise<{ id: string }> };

/** Submitted match reports for a fixture, with the official's name (SPEC-3,
 *  console). No plan gate — reports are free (D5). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "read");
    return fixtureReports(auth, id);
  });
}

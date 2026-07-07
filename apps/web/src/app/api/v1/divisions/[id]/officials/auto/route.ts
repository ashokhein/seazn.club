import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AutoAssignInput, autoAssignOfficials } from "@/server/usecases/officials";

type Ctx = { params: Promise<{ id: string }> };

/** Propose only — engine call with locked assignments as obstacles
 *  (Jul3/02 §4; same contract as schedule/auto). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AutoAssignInput);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return autoAssignOfficials(auth, id, body);
  });
}

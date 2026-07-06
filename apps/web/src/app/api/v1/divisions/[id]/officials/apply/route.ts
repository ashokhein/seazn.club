import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ApplyAssignmentsInput, applyOfficialAssignments } from "@/server/usecases/officials";

type Ctx = { params: Promise<{ id: string }> };

/** Transactional persist + `division_events: officials_assigned` (Jul3/02 §4). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, ApplyAssignmentsInput);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return applyOfficialAssignments(auth, id, body);
  });
}

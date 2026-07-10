import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchDivision } from "@/server/api-v1/schemas";
import { deleteDivision, getDivision, patchDivision } from "@/server/usecases/divisions";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return getDivision(auth, id);
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchDivision);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return patchDivision(auth, id, body);
  });
}

/** v3/09 §4 — setup-state hard delete (204) or archived-30d purge; started/
 *  resulted divisions answer 409 DIVISION_HAS_RESULTS with {archive: true}. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    await deleteDivision(auth, id);
    return reply(204, null);
  });
}

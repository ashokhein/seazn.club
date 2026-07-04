import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchDivision } from "@/server/api-v1/schemas";
import { getDivision, patchDivision } from "@/server/usecases/divisions";

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

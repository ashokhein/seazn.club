import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchCompetition } from "@/server/api-v1/schemas";
import { getCompetition, patchCompetition, deleteCompetition } from "@/server/usecases/competitions";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    return getCompetition(auth, id);
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchCompetition);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return patchCompetition(auth, id, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    await deleteCompetition(auth, id);
    return { deleted: true };
  });
}

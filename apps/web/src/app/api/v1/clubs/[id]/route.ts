import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchClub } from "@/server/api-v1/schemas";
import { getClub, patchClub, deleteClub } from "@/server/usecases/clubs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "club", id, "read");
    return getClub(auth, id);
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchClub);
    const auth = await requireResourceAuth(req, "club", id, "write");
    return patchClub(auth, id, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "club", id, "write");
    await deleteClub(auth, id);
    return { deleted: true };
  });
}

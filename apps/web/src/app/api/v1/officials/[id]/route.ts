import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import {
  PatchOfficialInput,
  listOfficials,
  patchOfficial,
  deleteOfficial,
} from "@/server/usecases/officials";
import { HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "official", id, "read");
    const official = (await listOfficials(auth)).find((o) => o.id === id);
    if (!official) throw new HttpError(404, "official not found");
    return official;
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchOfficialInput);
    const auth = await requireResourceAuth(req, "official", id, "write");
    return patchOfficial(auth, id, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "official", id, "write");
    await deleteOfficial(auth, id);
    return { deleted: true };
  });
}

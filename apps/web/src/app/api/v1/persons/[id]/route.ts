import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchPerson } from "@/server/api-v1/schemas";
import { getPerson, patchPerson } from "@/server/usecases/persons";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    return getPerson(auth, id);
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchPerson);
    const auth = await requireResourceAuth(req, "person", id, "write");
    return patchPerson(auth, id, body);
  });
}

import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateDivision } from "@/server/api-v1/schemas";
import { listDivisions, createDivision } from "@/server/usecases/divisions";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    return listDivisions(auth, id);
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateDivision);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return reply(201, await createDivision(auth, id, body));
  });
}

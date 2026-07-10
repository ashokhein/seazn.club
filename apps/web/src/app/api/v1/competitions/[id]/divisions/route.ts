import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateDivision } from "@/server/api-v1/schemas";
import { listDivisions, createDivision } from "@/server/usecases/divisions";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    // ?archived=1 — the competition-settings "Archived divisions" list
    // (v3/09 §4); default hides archived rows.
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    return listDivisions(auth, id, { includeArchived });
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

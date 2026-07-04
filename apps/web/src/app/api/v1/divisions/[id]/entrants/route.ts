import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateEntrants } from "@/server/api-v1/schemas";
import { listEntrants, createEntrants } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return listEntrants(auth, id);
  });
}

/** Register one entrant, or a JSON array for bulk import (doc 08 §3). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateEntrants);
    const auth = await requireResourceAuth(req, "division", id, "write");
    const rows = await createEntrants(auth, id, Array.isArray(body) ? body : [body]);
    return reply(201, Array.isArray(body) ? rows : rows[0]);
  });
}

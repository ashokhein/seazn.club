import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { createCheckpoint, listCheckpoints } from "@/server/usecases/history";
import { CreateCheckpoint } from "@/server/api-v1/schemas";

type Ctx = { params: Promise<{ id: string }> };

// The openapi ROUTES entry already declares S.CreateCheckpoint as this route's
// request shape; reuse it rather than keeping a second local copy that has to
// be remembered when the schema gains a field (it just did — `kind`).
const Body = CreateCheckpoint;

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return listCheckpoints(auth, id);
  });
}

/** Named save point at the current watermark (Jul3/03 §2, 16 Jun). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return reply(201, await createCheckpoint(auth, id, body.label, body.kind));
  });
}

import { v1, parseBody } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { PutLineup } from "@/server/api-v1/schemas";
import { getLineup, putLineup } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string; entrantId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, entrantId } = await params;
    const auth = await requireFixtureActor(req, id, "read");
    return getLineup(auth, id, entrantId);
  });
}

/** Replace an entrant's lineup for the fixture (doc 08 §3). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, entrantId } = await params;
    const body = await parseBody(req, PutLineup);
    const auth = await requireFixtureActor(req, id, "score");
    return putLineup(auth, id, entrantId, body);
  });
}

import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { SourceOfficialsInput, sourceOfficials } from "@/server/usecases/officials";

type Ctx = { params: Promise<{ id: string }> };

/** Resolve rank/result sourcing → officiating entrants (Jul3/02 §3; resolves
 *  only once the source stage/fixture is decided — the phased affordance). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, SourceOfficialsInput);
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return sourceOfficials(auth, id, body);
  });
}

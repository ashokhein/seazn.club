import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";

type Ctx = { params: Promise<{ id: string }> };

/** Mid-tournament withdrawal with fixture surgery (spec 05 §5): tables
 *  expunge (<50% played) or walk over; brackets walk over; open formats void
 *  remaining. Before a start it's a plain status flip. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    return withdrawEntrantCascade(auth, id);
  });
}

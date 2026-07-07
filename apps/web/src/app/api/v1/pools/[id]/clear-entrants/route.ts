import { z } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { clearPoolEntrants } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ confirm: z.literal(true) });

/** Remove all teams in a pool, keep the pool (Jul3/03 §5, 2 Jul). Blocked
 *  once any pool fixture is decided; undoable. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    const auth = await requireAuth(req, "write");
    return clearPoolEntrants(auth, id, body.confirm);
  });
}

import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { commitImport } from "@/server/usecases/imports";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/imports/{id}/commit — execute the plan in one transaction.
 *  Idempotency-Key header (doc 08 §4) makes retries safe. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "import", id, "write");
    const result = await commitImport(auth, id, req.headers.get("idempotency-key"));
    return reply(201, result);
  });
}

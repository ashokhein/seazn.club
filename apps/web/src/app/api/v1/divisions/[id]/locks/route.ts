import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { LockInput, setDivisionLocks } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

/** Whole-division freeze + scope locks (Jul3/03 §4; scope locks are Pro). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, LockInput);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return setDivisionLocks(auth, id, body);
  });
}

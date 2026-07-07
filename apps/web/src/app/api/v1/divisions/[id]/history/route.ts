import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionHistory } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

/** Ledger slice: type, actor, time, undoable/undone flags (Jul3/03 §6). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return divisionHistory(auth, id);
  });
}

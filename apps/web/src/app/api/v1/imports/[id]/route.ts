import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { getImport } from "@/server/usecases/imports";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/imports/{id} — re-preview without re-upload (Jul3/01 §6). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "import", id, "read");
    return getImport(auth, id);
  });
}

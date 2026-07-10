import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { archiveDivision, restoreDivision } from "@/server/usecases/divisions";

type Ctx = { params: Promise<{ id: string }> };

/** v3/09 §4 — archive: hidden from console/public/quota, restorable. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    return archiveDivision(auth, id);
  });
}

/** Restore an archived division (quota re-checked). The design doc names this
 *  POST …/restore; that path is taken by the Jul3/03 checkpoint restore, so
 *  un-archiving is DELETE on the archive resource instead. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    return restoreDivision(auth, id);
  });
}

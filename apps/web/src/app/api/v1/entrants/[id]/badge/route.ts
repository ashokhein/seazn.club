import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { setEntrantBadge } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/entrants/[id]/badge — multipart single 'file' upload; stores
 *  the crest in the assets bucket and sets entrants.badge_url to the storage
 *  path (PROMPT-60). External URLs go through PATCH /entrants/{id} instead. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' entry required");
    return setEntrantBadge(auth, id, {
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  });
}

/** DELETE — clear the entrant's badge (falls back to team logo → monogram). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    return setEntrantBadge(auth, id, null);
  });
}

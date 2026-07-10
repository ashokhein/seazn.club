import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { setTeamLogo, removeTeamLogo } from "@/server/usecases/teams";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/teams/{id}/logo — multipart single 'file' (v3/03 §5; mirrors
 *  the club badge pipeline). DELETE clears the pointer; the team then falls
 *  back to its club badge via team_display_v. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "team", id, "write");
    const form = await req.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) throw new HttpError(400, "multipart 'file' required");
    return setTeamLogo(auth, id, {
      contentType: entry.type,
      bytes: Buffer.from(await entry.arrayBuffer()),
    });
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "team", id, "write");
    await removeTeamLogo(auth, id);
    return { ok: true };
  });
}

import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { setPersonPhoto } from "@/server/usecases/persons";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/persons/[id]/photo — multipart single 'file' upload; sets the
 *  player's photo_path. Display is still gated by the public_photo consent. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "write");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' entry required");
    return setPersonPhoto(auth, id, {
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  });
}

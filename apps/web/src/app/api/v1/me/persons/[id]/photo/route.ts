import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { setMyPersonPhoto } from "@/server/usecases/me";

type Ctx = { params: Promise<{ id: string }> };

/** Player-owned photo (PROMPT-65 §2): same ownership + guardian rules as the
 *  consent route; storage pipeline shared with the organiser upload. The
 *  public card still shows the photo only with public_photo consent. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "person");
    const user = await requireUser();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' entry required");
    return setMyPersonPhoto(user.id, id, {
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  });
}

/** Remove my photo (the card falls back to initials). */
export async function DELETE(_req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "person");
    const user = await requireUser();
    return setMyPersonPhoto(user.id, id, null);
  });
}

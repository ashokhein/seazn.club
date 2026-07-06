import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchFixtureOfficialsInput, patchFixtureOfficials } from "@/server/usecases/officials";

type Ctx = { params: Promise<{ id: string }> };

/** Manual set/move/lock (Jul3/02 §4, drag-drop 7 Jan). Single-role manual
 *  assignment is free on every plan. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchFixtureOfficialsInput);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return patchFixtureOfficials(auth, id, body);
  });
}

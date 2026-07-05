import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth, requireFixtureActor } from "@/server/api-v1/auth";
import { PatchFixture } from "@/server/api-v1/schemas";
import { getFixture, patchFixture } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireFixtureActor(req, id, "read");
    return getFixture(auth, id);
  });
}

/** Schedule, venue, officials (doc 08 §3). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchFixture);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return patchFixture(auth, id, body);
  });
}

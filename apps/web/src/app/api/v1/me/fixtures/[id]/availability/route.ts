import { v1, parseBody } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { PutAvailability } from "@/server/api-v1/schemas";
import { setMyAvailability } from "@/server/usecases/me";

type Ctx = { params: Promise<{ id: string }> };

/** RSVP (PROMPT-53): in/out/maybe + note, upsert per (fixture, my person).
 *  Session only — the fixture must involve one of the caller's claimed
 *  persons (403 NOT_YOUR_FIXTURE otherwise). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "fixture");
    const body = await parseBody(req, PutAvailability);
    const user = await requireUser();
    return setMyAvailability(user.id, id, body);
  });
}

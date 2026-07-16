import { v1, parseBody } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { OfficiatingResponseInput } from "@/server/api-v1/schemas";
import { setMyOfficiatingResponse } from "@/server/usecases/me-officiating";

type Ctx = { params: Promise<{ id: string }> };

/** Accept / decline an officiating assignment (PROMPT-57). Session only —
 *  the fixture must be assigned to one of the caller's claimed officials
 *  (403 NOT_YOUR_ASSIGNMENT otherwise). Transitions are guarded in the
 *  usecase; a decline flags on the organiser console, never auto-reassigns. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "fixture");
    const body = await parseBody(req, OfficiatingResponseInput);
    const user = await requireUser();
    return setMyOfficiatingResponse(user.id, id, body);
  });
}
